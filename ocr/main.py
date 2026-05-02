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

CRITICAL INSTRUCTION: You must return ONLY a raw, valid JSON object. Do NOT include markdown formatting (like ```json), do NOT include explanations, and do NOT add any conversational text. The response must start strictly with { and end with }.

Return exactly this JSON structure:
{
    "supermercado": "Clean commercial name of the store",
    "tipo_comercio": "Supermercado, Restaurante, Farmacia, Moda, Electronica, or Otros",
    "fecha_tiquet": "YYYY-MM-DD HH:MM",
    "total": 0.00,
    "metodo_pago": "Efectivo, Tarjeta, or Otros",
    "productos": [
        {
            "cantidad": 1,
            "marca": "Manufacturer or main brand",
            "producto": "Clean, fully expanded descriptive name in Title Case",
            "precio": 0.00,
            "categoria": "Alimentacion, Bebidas, Higiene, Hogar, Mascotas, Ropa, Electronica, Descuento, Fruta/Verdura, Bolsas/Envases, or Otros"
        }
    ]
}

═══════════════════════════════════════════════════════════
EXTRACTION & CLEANING RULES (STRICT COMPLIANCE REQUIRED)
═══════════════════════════════════════════════════════════

1. ABSOLUTE EXCLUSIONS (DO NOT INCLUDE IN "productos")
   - Parking entries, validations, or tickets of ANY kind (e.g., "PARQUING", "TICKET PARKING", "DTO. PARKING"), regardless of whether their price is 0.00 or a non-zero value.
   - Items with a final price of exactly 0.00.
   - Payment method lines: "Tarjeta", "Visa", "Mastercard", "Efectivo", "Metálico", "Contactless".
   - Change lines: "Su cambio", "Cambio", "Entregado".
   - VAT/Tax breakdown lines: "IVA", "BASE IMPOSABLE", "QUOTA", tax percentages.
   - Loyalty points, "CLUB CARREFOUR", or "VENTAJAS OBTENIDAS" summary lines.
   - Total / subtotal summary rows.

2. DISCOUNTS & SPLIT PRICES (CRITICAL CARREFOUR FIX)
   - "categoria" MUST be "Descuento".
   - "precio" MUST be a STRICTLY NEGATIVE float (e.g., -0.73).
   - OCR SPLIT DECIMAL FIX: If you encounter a price that ends with a comma (e.g., "-0," or "1,"), the OCR has split the number. You MUST scan the immediate next available numbers in the OCR text to find the 1 or 2-digit decimals (e.g., "73" or "90"). Combine them mathematically: "-0," and "73" = -0.73. NEVER output a number ending in a comma or a string.

3. PRODUCT NAME ("producto") — CLEAN & EXPAND
   - EXPAND ABBREVIATIONS: Use your knowledge to expand supermarket abbreviations logically. 
     * Example: "T.VERD MARACUYA" -> "Te Verde Maracuya"
     * Example: "B.ENER.CACA.CA" -> "Barrita Energetica Cacao"
   - Be aggressive expanding abbreviations for cosmetics and cleaning supplies (e.g., "GEL DUCHA V." -> "Gel Ducha", "DES. ALOE R." -> "Desodorante Aloe Roll-on", "DETERG. LIQ" -> "Detergente Liquido").
   - REMOVE TRAILING TAX INDICATORS: Spanish receipts end product lines with isolated characters ("O", "0", "A", "B", "C"). You MUST remove them. "T.VERD MARACUYA O" -> "Te Verde Maracuya".
   - Remove noise: Store IDs, asterisks, arrows (↓), "REF.".

4. BRAND ("marca")
   - Extract the manufacturer. If the item implies a store brand (e.g., "ARANDANO CARRE"), use the store name (e.g., "Carrefour"). If unknown, use "Generica".

5. QUANTITY & UNIT PRICE ENFORCEMENT (CRITICAL)
   - "precio" MUST be the price of exactly ONE unit. Ensure it is a FLOAT.
   - When "cantidad" > 1, receipts usually print: [QTY] [NAME] [UNIT PRICE] [LINE TOTAL] (e.g., "2 BARRITA CACAO 1,65 3,30").
   - You MUST extract the UNIT PRICE (1.65) for the "precio" field. NEVER extract the line total (3.30).
   - FALLBACK MATH: If the OCR only captured the line total and the unit price is missing from the text, you MUST mathematically divide the line total by "cantidad" to determine the true "precio" (e.g., 3.30 / 2 = 1.65).
   - Weighted produce (fresh fruit/vegetables): Category is "Fruta/Verdura". "cantidad" MUST be the WEIGHT in kilograms (kg) as a float (e.g., 0.750). "precio" MUST be the PRICE PER KILOGRAM (€/kg).

6. SUPERMARKET ("supermercado") & DATE ("fecha_tiquet")
   - Extract clean commercial name (remove S.A., S.L., Centros Comerciales).
   - Date: Convert to ISO (YYYY-MM-DD HH:MM). If missing, return null.

7. EXTREME OCR FRAGMENTATION & COLUMN MAPPING
   - Prices and items may be heavily disjointed. Carefully map the floating prices (especially negative ones) to their corresponding discount descriptions.

8. DEDUPLICATION & GHOST READING PREVENTION (CRITICAL)
   - NEVER duplicate an item unless it explicitly appears printed on multiple separate lines on the receipt.
   - Do not confuse descriptive sub-lines, weight info, or OCR ghosting as separate products.
   - If you are about to output two identical items (same name, same price), stop and double-check the raw text. If the raw text only shows that line once, you MUST output it only once.
   - If a product has a quantity of >1 (e.g., "2 PICO RST.RUSTICO"), output a SINGLE JSON object with "cantidad": 2. NEVER split it into two JSON objects of quantity 1.

9. ELIMINATE TRUNCATED GHOST READINGS (CRITICAL)
   - The OCR often creates partial/truncated duplicate lines (e.g., reading a fragment like "CARBASS VERD" right next to the real item "CARBASSO VERD").
   - If you detect a product that is clearly a fragmented, truncated, or ghost reading of another product, YOU MUST DELETE IT. 
   - Do NOT attempt to fix its name and DO NOT include it in the final "productos" array. Just completely ignore it and drop it from the JSON.

10. FINAL REMINDER
    - Return ONLY raw JSON. No markdown blocks. No explanations.
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