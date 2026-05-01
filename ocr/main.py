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
You are an expert Retail Data Analyst and Bookkeeper. Your objective is to extract information from a receipt (ticket) image and standardize it into a highly professional catalog format.

CRITICAL INSTRUCTION: You must return ONLY a raw, valid JSON object. Do NOT include markdown formatting (like ```json), do NOT include explanations, and do NOT add any conversational text.

Return exactly this JSON structure:
{
    "supermercado": "Clean commercial name of the store",
    "tipo_comercio": "Supermercado, Restaurante, Farmacia, Moda, Electronica, or Otros",
    "fecha_tiquet": "YYYY-MM-DD HH:MM (or YYYY-MM-DD if no time is visible, or null if missing)",
    "total": 0.00,
    "metodo_pago": "Efectivo, Tarjeta, or Otros",
    "productos": [
        {
            "cantidad": 1,
            "marca": "Manufacturer or main brand",
            "producto": "Clean, descriptive name in Title Case",
            "precio": 0.00,
    "categoria": "Alimentacion, Bebidas, Higiene, Hogar, Mascotas, Ropa, Electronica, Descuento, Fruta/Verdura, or Otros"
        }
    ]
}

═══════════════════════════════════════════════════════════
EXTRACTION & CLEANING RULES (STRICT COMPLIANCE REQUIRED)
═══════════════════════════════════════════════════════════

1. PAYMENT METHOD & ZERO-VALUE EXCLUSIONS (CRITICAL)
   - Determine the payment method for "metodo_pago". Map "Metálico", "Efectivo" to "Efectivo". Map "Visa", "Mastercard", "Contactless" to "Tarjeta".
   - EXCLUDE payment methods, change ("Su cambio"), VAT breakdown, or loyalty points from the products array.
   - EXCLUDE ANY ITEM OR DISCOUNT WITH A FINAL PRICE OF 0 OR 0.00.

2. DISCOUNTS & CARREFOUR FIX (CRITICAL ALGORITHM)
   - NEVER use placeholders like "__descuento__". Use a descriptive name (e.g., "Descuento 2da Unidad").
   - "categoria" MUST be "Descuento".
   - "precio" MUST be a STRICTLY NEGATIVE float (e.g., -0.90).
   - IF THE PRICE LOOKS LIKE "-0," OR "-0": This is an incomplete OCR read. DO NOT output -0.00. You MUST search the text below it for the missing cents (like "90"). 
   - IF CENTS ARE LOST INLINE: Go to the very bottom of the receipt, look for "VENTAJAS OBTENIDAS" or "DESCUENTOS". If you see "0," and "90" there, combine them and use "-0.90" as the discount price.

3. CATEGORY ("categoria")
   - Must be strictly one of: "Alimentacion", "Bebidas", "Higiene", "Hogar", "Mascotas", "Ropa", "Electronica", "Descuento", "Fruta/Verdura", "Otros".

4. SUPERMARKET ("supermercado") & DATE ("fecha_tiquet")
   - Extract clean commercial name (remove S.A., S.L.).
   - Date: Convert to ISO (YYYY-MM-DD HH:MM). If missing, return null.

5. BRAND ("marca")
   - Extract the manufacturer. For store brands, use "Hacendado", "Carrefour", "Bosque Verde", etc. If unknown, use "Generica".

6. PRODUCT NAME ("producto") — CLEAN TITLE CASE
   - Remove noise: Store IDs, asterisks, arrows (↓), "B. ENER.", "REF.".
   - Fix OCR fused characters and expand abbreviations.
   - REMOVE TRAILING TAX INDICATORS: Spanish receipts often end product names with a single isolated letter or number (e.g., " O", " 0", " A", " B", "*"). You MUST remove these trailing isolated characters. Example: "TEA VERD MARACUYA O" -> "Tea Verd Maracuya".

7. QUANTITY & PRICE ("cantidad" & "precio") & TOTAL
   - IMPORTANT: Use UNIT values. "precio" is the price of ONE item.
   - For weighted produce (fresh fruit/vegetables), set "categoria" = "Fruta/Verdura".
     * "cantidad" MUST be the WEIGHT in kilograms (kg), with decimals (e.g., 0.750).
     * "precio" MUST be the PRICE PER KILOGRAM (€/kg), NOT the line total.
     * If the receipt shows total + €/kg, derive the weight. If it shows total + weight, derive €/kg.
   - For non-weighted items, "cantidad" should be an integer (1, 2, 3...). If OCR reads "2.01", fix it to "2".
   - Extract the final receipt sum for the root "total" field.
   - Ensure "precio", "cantidad", and "total" are NUMBERS (float/int), not strings.

8. EXTREME OCR FRAGMENTATION & COLUMN MAPPING
   - Receipts often have extreme OCR fragmentation where ALL item names are read first, and ALL prices are read 10+ lines later. 
   - You MUST logically map the detached prices to the items. 
   - If a price is cut off at the comma (e.g., "-0," on one line and "90" on another), YOU MUST CONCATENATE THEM. A comma at the end of a number ALWAYS means the decimal part is on a following line.

9. FINAL REMINDER
   - Return ONLY raw JSON. No markdown blocks. No text.
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
    if 'fruta' in s_lower and 'verdura' in s_lower:
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
