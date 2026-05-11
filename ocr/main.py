"""
main.py — OCR con Gemini + MOTOR DE NORMALIZACIÓN INTEGRADO
Cambio clave: _procesar_y_limpiar_productos guarda el campo 'nombre_ocr'
con el texto original del modelo (antes de normalizar) para que server.js
pueda almacenarlo en compras.nombre_original y aprender vinculaciones.
"""
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from zoneinfo import ZoneInfo
from datetime import datetime
import os, json, cv2, numpy as np, re, io
from PIL import Image
from pdf2image import convert_from_bytes
from dotenv import load_dotenv

load_dotenv()

LLAVES_API = []
for i in range(1, 11):
    valor = os.getenv(f"CLAVE_{i}")
    if valor and valor.strip():
        LLAVES_API.append(valor.strip().strip(' "\''))

if not LLAVES_API:
    fallback = os.getenv("CLAVE_API")
    if fallback:
        LLAVES_API.append(fallback.strip().strip(' "\''))

indice_llave_actual = 0
MADRID = ZoneInfo("Europe/Madrid")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

CATEGORIAS_VALIDAS = {
    "Alimentacion", "Bebidas", "Higiene", "Hogar",
    "Mascotas", "Ropa", "Electronica", "Descuento",
    "Fruta/Verdura", "Otros"
}

PROMPT = """
Role & Objective 
You are an Expert Retail and Accounting Data Analyst. Your goal
is to extract the information from the receipt (ticket) image and standardize it
into a JSON format.

🚨 CRITICAL INSTRUCTION Return ONLY a raw JSON object. NO markdown tags (```json)
around the output, and NO explanations.

❌ EXTRACTION RULES - ABSOLUTE PROHIBITIONS!

  - 1. THE MULTIPLICATION ERROR (Multiple Quantities):

      - Lines with more than one item have TWO prices (e.g., "2 TRUITA
        PATATA/CEBA 2,80 5,60").
      - The first number (2.80) is the UNIT PRICE. The last one (5.60) is the
        SUBTOTAL.
      - Action: ALWAYS EXTRACT THE UNIT PRICE. If you extract the subtotal, the
        system will multiply it again and ruin the accounting.
      - Example: "2 TOMAQUET TRITURAT 1,00 2,00" -> Quantity: 2 | Price: 1.00.

  - 2. THE "MADUIXOT" ERROR (Weighed items on a single line):

      - If the line says "1 MADUIXOT 1,3 KG 3,21", the 3.21 is the TOTAL PRICE.
      - Action: You MUST DIVIDE the total by the weight to get the unit price.
      - Internal Calculation: 3.21 / 1.3 = 2.47 €/kg.
      - Result: Quantity: 1.3 | Price: 2.47 | Category: "Fruta/Verdura".

  - 3. THE BROCCOLI RULE AND THE CATEGORY:

      - If the word "kg" does NOT appear LITERALLY written next to the product
        (e.g., "1 BROQUIL 2,00"), it is 1 whole unit.
      - Action: Its category MUST BE "Alimentacion" (NEVER "Fruta/Verdura"!).
        Only items where "kg" is explicitly printed go into "Fruta/Verdura".

  - 4. WEIGHED FRUIT ON TWO LINES (Do not duplicate!):

      - Example: "1 MANDARINA" on one line, and below "1,428 kg 2,35 €/kg 3,36".
      - Action: MERGE BOTH LINES INTO A SINGLE PRODUCT. Ignore the initial "1"
        and the 3.36 total.
      - Result: Quantity: 1.428 | Price: 2.35 | Category: "Fruta/Verdura".

  - 5. NUMBERS IN NAMES AND GARBAGE LINES:

      - Example: "1 12 OUS GRANS L 3,20" -> Quantity: 1 | Product: "12 Ous Grans
        L" | Price: 3.20.
      - Action: COMPLETELY IGNORE AND DO NOT INCLUDE: "PARQUING", "ENTRADA",
        "SORTIDA", "TOTAL", "METALICO", credit cards, and lines with a price
        of 0.00€.

🛒 SUPERMARKET STANDARDIZATION

Identify the main brand and remove legal suffixes or generic words (S.A., S.L.,
S.A.U., S.Coop, Supermercats, Supermercados, Centros Comerciales, Retail, etc.).
The result MUST BE a single word in UPPERCASE with the clean commercial name.

Mandatory examples:

  - "Condis Supermercats" ➔ CONDIS
  - "Mercadona S.A." ➔ MERCADONA
  - "Centros Comerciales Carrefour" ➔ CARREFOUR
  - "Lidl Supermercados" ➔ LIDL
  - "Dia Retail" ➔ DIA
  - "Consum S.Coop" ➔ CONSUM
  - "Bon Preu" or "Bonpreu" ➔ BONPREU
  - "Caprabo S.A." ➔ CAPRABO

📋 REQUIRED JSON STRUCTURE

{
  "_razonamiento": "1. Multiple units: I will extract only the first price (Unit price) to prevent the database from multiplying it twice. 2. Maduixot: I will calculate total price/kilos (3.21/1.3=2.47). 3. Broccoli: Since it doesn't have 'kg' printed, I will set quantity to 1 and category to 'Alimentacion'. 4. I will not duplicate weighed fruits nor include Parking. 5. I will standardize the supermarket's commercial name by omitting suffixes.",
  "supermercado": "CLEAN commercial brand name in UPPERCASE (e.g. MERCADONA, CONDIS, CARREFOUR)",
  "fecha_tiquet": "YYYY-MM-DD HH:MM:SS",
  "total_tiquet": 0.00,
  "metodo_pago": "Efectivo, Tarjeta, or Otros",
  "productos":[
    {
      "cantidad": 1.000,
      "marca": "Generica",
      "producto": "Clean Name",
      "precio": 0.00,
      "categoria": "Alimentacion, Bebidas, Higiene, Hogar, Mascotas, Ropa, Electronica, Descuento, Fruta/Verdura, Otros"
    }
  ]
}

"""


def normalizar_nombre_producto(texto: str) -> str:
    if not texto: return "Desconocido"
    texto = texto.upper()
    if "DESCUENTO" in texto: return "DESCUENTO APLICADO"

    patron_metrica = r'(?P<numero>\d+(?:[.,]\d+)?)\s*(?P<unidad>G|GR|KG|ML|M|CL|L)\b'
    match = re.search(patron_metrica, texto)
    volumen_estandar = ""
    if match:
        num = match.group('numero').replace(',', '.')
        uni = match.group('unidad')
        if uni in ['M', 'ML']: uni = 'ML'
        elif uni in ['G', 'GR']: uni = 'G'
        volumen_estandar = f"{num}{uni}"
        texto = re.sub(patron_metrica, '', texto)

    texto = re.sub(r'B\.\s*ENER\.?', '', texto)
    texto = re.sub(r'REF\.?\d*', '', texto)
    texto = re.sub(r'[^A-Z0-9\s]', '', texto)
    texto = re.sub(r'\s+[A-Z0-9]$', '', texto)

    nombre_base = re.sub(r'\s+', ' ', texto).strip()
    return f"{nombre_base} {volumen_estandar}".strip().title()

def _sanitizar_categoria(cat: str) -> str:
    if not cat: return "Otros"
    s = cat.strip()
    if s in CATEGORIAS_VALIDAS: return s
    s_lower = s.lower()
    normalized = re.sub(r'[\s/]+', '', s_lower)
    if normalized == 'frutaverdura':
        return "Fruta/Verdura"
    for v in CATEGORIAS_VALIDAS:
        if v.lower() == s_lower: return v
    return "Otros"


def _procesar_y_limpiar_productos(productos: list) -> list:
    resultado = []
    for p in productos:
        try:
            p['precio'] = float(str(p.get('precio', 0)).replace(',', '.'))
        except ValueError:
            p['precio'] = 0.0
        try:
            p['cantidad'] = float(str(p.get('cantidad', 1)).replace(',', '.'))
        except ValueError:
            p['cantidad'] = 1.0

        es_desc = (str(p.get('categoria', '')).lower() == 'descuento' or p['precio'] < 0)
        p['es_descuento'] = es_desc
        p['categoria'] = 'Descuento' if es_desc else _sanitizar_categoria(p.get('categoria', 'Otros'))

        p['marca'] = str(p.get('marca', 'Genérico')).strip().title()

        nombre_ia = p.get('producto', 'Desconocido')

        # ── CLAVE DEL SISTEMA DE VINCULACIÓN ────────────────────
        p['nombre_ocr'] = nombre_ia.strip().upper() if nombre_ia else 'DESCONOCIDO'

        # Ahora sí normalizamos el nombre para mostrarlo al usuario
        p['producto'] = "Descuento Aplicado" if es_desc else normalizar_nombre_producto(nombre_ia)

        resultado.append(p)
    return resultado


def extrae_datos(imagen_bytes: bytes) -> dict:
    global indice_llave_actual
    total_llaves = len(LLAVES_API)
    if total_llaves == 0: return {"error": "No API keys"}

    # --- NUEVA LÓGICA PARA EVITAR ERROR CV2 CON PDF ---
    try:
        if imagen_bytes.startswith(b'%PDF'):
            paginas = convert_from_bytes(imagen_bytes, first_page=1, last_page=1)
            if not paginas: return {"error": "PDF vacío"}
            img_pil = paginas[0].convert('RGB')
        else:
            arr    = np.frombuffer(imagen_bytes, np.uint8)
            img_cv = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img_cv is None: return {"error": "Imagen no válida"}
            img_pil = Image.fromarray(cv2.cvtColor(img_cv, cv2.COLOR_BGR2RGB))
    except Exception as e:
        return {"error": f"Error procesando archivo: {str(e)}"}

    intentos = 0
    while intentos < total_llaves:
        llave = LLAVES_API[indice_llave_actual]
        try:
            client = genai.Client(api_key=llave)
            res = client.models.generate_content(
                model="gemini-2.5-flash-lite",
                contents=[PROMPT, img_pil],
                config=types.GenerateContentConfig(response_mime_type="application/json"),
            )
            datos = json.loads(res.text.strip())
            if datos.get("productos"):
                datos["productos"] = _procesar_y_limpiar_productos(datos["productos"])
            return datos
        except Exception as e:
            print(f"[OCR] Llave {indice_llave_actual} falló: {e}")
            indice_llave_actual = (indice_llave_actual + 1) % total_llaves
            intentos += 1

    return {"error": "All keys exhausted"}


@app.post("/analizar")
async def analizar(file: UploadFile = File(...)):
    datos = extrae_datos(await file.read())

    # 1. Convertimos a texto asegurando que NO escape los caracteres latinos
    json_str = json.dumps(datos, ensure_ascii=False)

    # 2. Devolvemos la respuesta forzando la cabecera UTF-8
    return Response(content=json_str, media_type="application/json; charset=utf-8")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)