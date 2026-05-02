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

CRITICAL INSTRUCTION: You must return ONLY a raw, valid JSON object. Do NOT include markdown formatting (like ```json), explanations, or conversational text. Start strictly with { and end with }.

This is a long receipt. Speed is NOT a priority. Accuracy is. Take as many tokens as needed.

You MUST follow the FIVE-PASS METHOD below without skipping any pass.

═══════════════════════════════════════════════════════════
PASS 1 — RAW TRANSCRIPTION (_1_transcripcion_bruta)
═══════════════════════════════════════════════════════════

Transcribe EVERY line from the receipt image, top to bottom, into the "_1_transcripcion_bruta" array.

STRICT RULES:
- One printed line = one array element. NEVER merge two lines into one element.
- NEVER skip any line. Include ALL lines that contain a price or a kg weight.
- If the same product name appears twice, write BOTH as separate elements.
- For two-line produce items: the product NAME is one element. The weight/price breakdown line immediately below it is the NEXT separate element. These are TWO elements, not one.
- Stop at the TOTAL line (do not include it).

⚠ CRITICAL AFTER PASS 1 — DUPLICATE SANDWICH PRE-SCAN:
Before doing anything else, scan _1_transcripcion_bruta for any product name that appears more than once.
For EACH duplicate pair found:
  a) Record the index of the FIRST occurrence (index_first).
  b) Record the index of the LAST occurrence (index_last).
  c) List EVERY element between index_first+1 and index_last-1, one by one.
  d) Count them: this count = N_sandwich.
  e) STATE EXPLICITLY: "There are N_sandwich items sandwiched between these duplicates."
  f) COMMIT: "I will create N_sandwich product objects between these two duplicate entries."
DO NOT proceed to Pass 2 until this pre-scan is complete.

═══════════════════════════════════════════════════════════
PASS 2 — VERIFICATION (_2_verificacion)
═══════════════════════════════════════════════════════════

Fill this object after Pass 1 and BEFORE building the products array.

{
  "total_lineas_producto": <count only product name lines, not weight/detail sub-lines, not parking>,
  "total_productos_extraidos": "? (fill after Pass 3)",
  "suma_calculada": "? (fill after Pass 3)",
  "total_tiquet": <the total printed on the receipt, as float>,
  "diferencia_euros": "? (fill after Pass 3)",
  "duplicados_detectados": [
    "For EACH duplicate: 'PRODUCT NAME: index_first=N, index_last=M, N_sandwich=K items between them'"
  ],
  "items_entre_duplicados": {
    "PRODUCT_NAME": [
      "index N+1: '<raw line>' → product object #X in productos",
      "index N+2: '<raw line>' → product object #X+1 in productos",
      "... one entry per sandwiched line ..."
    ]
  },
  "produce_pairs_confirmed": [
    "For each produce item with a TWO-LINE format, write BEFORE building productos:",
    "  ITEM_NAME (index N) → weight line (index N+1): X kg × Y €/kg = Z total",
    "  cantidad = X, precio = Y",
    "Confirm each pair explicitly. Do NOT start building productos until all pairs are listed."
  ],
  "estado": "? (OK if diferencia <= 0.05, else REVISAR with explanation)"
}

═══════════════════════════════════════════════════════════
PASS 3 — STRUCTURED EXTRACTION (productos array)
═══════════════════════════════════════════════════════════

Build productos strictly in order using _1_transcripcion_bruta as the source of truth.

🔧 PRICE ANCHOR RULE (prevents price cross-contamination between adjacent items):
Before writing each product object, state internally:
  "I am processing index N: '<raw line>'. The price on THIS line is X.XX €."
Then write the product object using ONLY the price from that exact line.
Do NOT carry over, borrow, or re-use the price from the previous or next line.

🔧 SANDWICH PROTOCOL (mandatory sequence for every duplicate pair):
When you encounter index_first (the first duplicate), follow this EXACT sequence:

  STEP 1 — Write the FIRST duplicate object using the price on index_first's line.
  STEP 2 — For each sandwiched line (index_first+1 … index_last-1), in order:
    a) Quote the raw line from _1_transcripcion_bruta: "Line N text: '…'"
    b) Read the price from THAT EXACT LINE and state it: "Price on this line: X.XX"
    c) Write the product object using ONLY that price. Do NOT look ahead or behind.
  STEP 3 — After all sandwich items are written, write the SECOND duplicate object
    using the price on index_last's line (which is DIFFERENT from the first duplicate's
    price). This second object is NOT optional — it is a real purchase.
  STEP 4 — State: "Sandwich complete. Written N items between the two duplicates."
    If N ≠ N_sandwich from Pass 1 pre-scan, STOP and find the missing item(s).

⚠ CRITICAL: The price for the inserted item comes from ITS OWN LINE in
  _1_transcripcion_bruta — NOT from the line before it, NOT from the line after it.
  Never "carry over" a price from an adjacent line when inserting a sandwich item.

After every 5 products written, perform a SPOT CHECK:
- Read the last 5 entries in productos.
- For each one, locate its source index in _1_transcripcion_bruta.
- Verify that the precio in productos exactly matches the price printed on that source line.
- If any mismatch is found, fix it immediately before continuing.

═══════════════════════════════════════════════════════════
PASS 4 — MANDATORY SELF-AUDIT
═══════════════════════════════════════════════════════════

Execute ALL of the following checks before closing the JSON:

CHECK A — COUNT MATCH
  total_productos_extraidos (len of productos array) must equal total_lineas_producto.
  If they differ: find the missing lines in _1_transcripcion_bruta and add them.

CHECK B — DUPLICATE SANDWICH AUDIT (ENHANCED)
  For every pair listed in duplicados_detectados:
  1. Find both product objects in productos (by name and price).
  2. List every product object that sits between them in the array.
  3. Cross-reference with items_entre_duplicados for that pair, item by item.
  4. For EACH entry in items_entre_duplicados:
     - Search the productos array by name AND price.
     - If found: mark ✓ PRESENT.
     - If NOT found: mark ✗ MISSING → immediately insert it in the correct position.
  5. Confirm final count: (products between duplicates) == N_sandwich.
  6. PRICE CHECK on all sandwich items: for each inserted item, locate its source
     line in _1_transcripcion_bruta and verify the precio matches THAT line exactly.
     The most common error: the inserted item's precio matches the NEXT item's price
     (a cascade shift). If this is the case, fix ALL affected prices downstream.
  ⚠ DO NOT SKIP THIS CHECK. A missing sandwich item causes a total mismatch that
     is easy to overlook. The item WILL have a price on the receipt — find it.

CHECK C — PRICE VERIFICATION (line-by-line)
  For EVERY product object in productos:
  1. Locate its source line in _1_transcripcion_bruta by index.
  2. Extract the unit price printed on that exact line.
  3. Confirm it matches productos[i].precio exactly.
  If ANY mismatch is found: fix the precio before continuing.
  🔧 Pay special attention to consecutive items with similar prices
     (e.g. 1.20 and 1.80, 1.25 and 1.55) — these are the most common swap victims.

CHECK D — SUBTOTAL CROSS-CHECK (per item)
  For every non-produce product (categoria ≠ "Fruta/Verdura"):
    expected_subtotal = cantidad × precio
    Locate the printed subtotal on that product's source line in _1_transcripcion_bruta.
    If expected_subtotal ≠ printed_subtotal (tolerance: 0.01€): the precio is WRONG.
    Re-read the receipt line and correct it before continuing.
  This catches misread prices that the sum check might absorb as rounding.

CHECK E — SUM CHECK
  Calculate suma_calculada = sum of all (cantidad × precio) in productos.
  Calculate diferencia_euros = abs(total_tiquet - suma_calculada).
  If diferencia_euros > 0.05€:
    Step 1: Re-run CHECK B. A missing sandwich item is the most likely cause.
    Step 2: Re-run CHECK C to find any misread price.
    Step 3: Re-count total_lineas_producto vs len(productos). Add any missing item.
    Step 4: Fix all errors found. Recalculate until diferencia_euros <= 0.05.
  Set estado = "OK" only when diferencia_euros <= 0.05.
  Do NOT close the JSON with estado = "REVISAR" without first exhausting all correction steps.
  Note: a residual difference of ≤ 0.05€ is acceptable due to produce kg rounding.

═══════════════════════════════════════════════════════════
PASS 5 — FINAL NUMERICAL RECONCILIATION
═══════════════════════════════════════════════════════════

This pass exists solely to catch the one failure mode where all previous checks pass
but the sum still does not match — typically caused by a single skipped low-price item.

  1. Sort productos by their source index (the order they appear in _1_transcripcion_bruta).
  2. Walk _1_transcripcion_bruta from index 0 to the last product line.
  3. For each line that contains a price (look for comma-separated decimals like "1,25"):
     - Confirm there is a product object in productos whose precio matches that line's price
       AND whose position in the array corresponds to that index.
     - If no match: that line was SKIPPED. Create the product object and insert it.
  4. Recalculate suma_calculada and diferencia_euros.
  5. Update _2_verificacion accordingly and set estado = "OK" if diferencia <= 0.05.

═══════════════════════════════════════════════════════════
FULL JSON STRUCTURE
═══════════════════════════════════════════════════════════

{
    "_1_transcripcion_bruta": [ ... ],
    "_2_verificacion": { ... },
    "supermercado": "Extract the commercial brand name ONLY if it is explicitly printed as such (e.g. 'MERCADONA', 'LIDL', 'CARREFOUR'). Output \"Desconocido\" if the header contains ONLY: an address, postal code, city name, phone number, tax ID (CIF/NIF starting with A-, B-, etc.), invoice number, or any combination of these — with NO recognisable retail brand name. Do NOT infer or guess the chain from the address or phone number. NEGATIVE EXAMPLES that must output \"Desconocido\": '08911 BADALONA', 'C/ SEU D\'URGELL 44', '938347360', 'A-46103834', 'FACTURA SIMPLIFICADA: 4176-013-400798'.",
    "tipo_comercio": "Supermercado, Restaurante, Farmacia, Moda, Electronica, or Otros",
    "fecha_tiquet": "YYYY-MM-DD HH:MM",
    "total": 0.00,
    "metodo_pago": "Efectivo, Tarjeta, or Otros",
    "productos": [
        {
            "cantidad": 1,
            "marca": "Manufacturer or main brand (or 'Generica')",
            "producto": "Clean, fully expanded descriptive name in Title Case",
            "precio": 0.00,
            "categoria": "Alimentacion, Bebidas, Higiene, Hogar, Mascotas, Ropa, Electronica, Descuento, Fruta/Verdura, Bolsas/Envases, or Otros"
        }
    ]
}

═══════════════════════════════════════════════════════════
EXTRACTION RULES
═══════════════════════════════════════════════════════════

1. EXACT PRICE EXTRACTION
   - Extract the EXACT printed unit price. Never invent or adjust a price.
   - Read prices horizontally on THAT exact line only.
   - A price belongs to the item on its own line, never to the item above or below.

2. ANTI-SHIFTING — PROCESS ONE ITEM AT A TIME
   - Work through _1_transcripcion_bruta strictly in order.
   - For each non-produce item: read the name and price on the same line, write the
     product object, then move to the next line.
   - For each two-line produce item (see Rule 6): read the name line, then IMMEDIATELY
     read the next line for weight/price data, write the complete product object, then
     advance. Do NOT move to the next product until the current produce pair is fully
     written.
   - After every 5 products, verify the last price written matches the price printed on
     that exact line in _1_transcripcion_bruta.

3. DUPLICATE PRODUCT NAMES
   - If the same name appears twice, create TWO separate product objects with their
     respective (potentially different) prices.
   - ALL items listed in _2_verificacion.items_entre_duplicados must appear as product
     objects between the two duplicates. Verify this explicitly in Pass 4 / CHECK B.
   ⚠ A product name appearing between two duplicate entries is NOT a third duplicate —
     it is a DIFFERENT product that happens to be sandwiched. Write it as its own object.

4. QUANTITY > 1 AND TWO-COLUMN PRICES
   - Format on receipt: [QTY] [ITEM NAME] [UNIT PRICE] [LINE TOTAL]
   - Always extract UNIT PRICE (first price), never the line total (last price).
   - Example: "2 TRUITA PATATA/CEBA 2,80 5,60" → cantidad: 2, precio: 2.80
   - Example: "6 PANET LLAVORS 0,35 2,10" → cantidad: 6, precio: 0.35

5. CATEGORY "Fruta/Verdura" — THE KG TEST (mandatory before every assignment)
   This category signals that the price is in €/kg. Assigning it incorrectly corrupts
   totals. Apply this single test before writing EVERY product's categoria:

   ══ THE KG TEST ══
   Ask: "Does THIS line, or the line immediately below it, contain 'kg' or 'KG'
         AND a price-per-kg rate (€/kg or X,XX €/kg)?"
   ▶ YES → categoria: "Fruta/Verdura"
   ▶ NO  → categoria: "Alimentacion" (or the appropriate non-produce category)
            NO EXCEPTIONS. The product's name is irrelevant.
            A broccoli, tomato, or onion sold WITHOUT a kg notation = Alimentacion.

   ✅ Fruta/Verdura — the ONLY two valid receipt patterns:
      FORMAT A — name on line N (no price), weight+price on line N+1:
        Line N:   "1 MANDARINA"
        Line N+1: "1,428 kg  2,35 €/kg  3,36"
        → Fruta/Verdura ✓

      FORMAT B — name + weight + total on one line:
        "1 MADUIXOT 1,3 KG 3,21"
        → Fruta/Verdura ✓ (see Rule 6 for price calculation)

   ❌ Alimentacion — memorize these exact receipt patterns:
      "1 BROQUIL 2,00"                    → Alimentacion, cantidad:1, precio:2.00
      "1 TOMAQUET NATURAL RAT 1,00"       → Alimentacion, cantidad:1, precio:1.00
      "2 TOMAQUET TRITURAT 1,00 2,00"     → Alimentacion, cantidad:2, precio:1.00
      "1 MONGETA RODONA A TR 1,45"        → Alimentacion, cantidad:1, precio:1.45
      "2 MONGETA BLANCA CUITA 0,80 1,60"  → Alimentacion, cantidad:2, precio:0.80
      Any "[QTY] [NAME] [PRICE]" line without kg = Alimentacion, always.

6. MULTI-LINE PRODUCE — THE ANCHOR RULE
   Two formats exist for produce with weight:

   FORMAT A — Two separate lines:
     Line N:   "1 MANDARINA"              ← product name line (ignore the "1")
     Line N+1: "1,428 kg 2,35 €/kg 3,36" ← weight/price line
     → cantidad: 1.428 (from line N+1), precio: 2.35 (from line N+1)
     → IGNORE the "1" on the name line — it is a placeholder, not the kg weight
     → IGNORE the line total 3.36

   FORMAT B — Single line with weight embedded:
     "1 MADUIXOT 1,3 KG 3,21"
     → The rightmost number (3,21) is the LINE TOTAL, NOT the unit price.
     → cantidad = the kg weight printed = 1.3
     → precio = line_total ÷ weight = 3.21 ÷ 1.3 = 2.47  (ALWAYS divide, never use total as price)
     → categoria: "Fruta/Verdura"
     → Remove weight notation from product name: "Maduixot"
     ⚠ NEVER set cantidad=1 and precio=line_total for FORMAT B items. That is always wrong.

   THE ANCHOR RULE: The weight on Line N+1 belongs to the product on Line N.
   List all pairs in _2_verificacion.produce_pairs_confirmed BEFORE building productos.

   ANTI-CASCADE CHECK FOR PRODUCE: After writing each produce item, verify:
     - The cantidad you used matches the kg on that item's weight line (NOT the next item's).
     - The precio you used matches the €/kg on that item's weight line (NOT the next item's).
   State explicitly: "BANANA: using its OWN weight line (index N+1): X kg × Y €/kg"
   Never write "1 kg" for a produce item unless the weight line literally says "1,000 kg" or "1 kg".

7. PRODUCT NAME FORMATTING
   - Expand truncated words to their full correct form:
     "ASSORTID" → "Assortida", "CONF." → "Conferència", "INTEG." → "Integral"
     "S/G" → "Sense Greix", "S/SUR" → "Sense Surimi", "FRANKFU" → "Frankfurt"
     "LLAMIN." → "Llaminadura", "PAT." → "Patates", "EMP" → "Empanada"
     "AVEN I SEMI" → "Avena i Semilles", "FARCIDA" → "Farcida"
     Apply this logic to any word that is clearly incomplete due to receipt character limits.
   - Remove trailing isolated tax indicator characters (" O", " A", " B") from name end.
   - Use Title Case for all product names.

8. ABSOLUTE EXCLUSIONS
   - Parking ("PARQUING", "TICKET PARKING", or any variant): NEVER create a product
     object for these, regardless of price (even 0.00). Do not include them in
     total_lineas_producto count either.
   - Items with a final printed price of exactly 0.00 that are not parking: exclude.
   - Payment lines, VAT summaries ("IVA", "BASE IMPOSABLE"), change lines: exclude.
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