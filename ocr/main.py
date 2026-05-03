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
PRE-PASS 0 — OCR CHARACTER CORRECTION (run BEFORE Pass 1)
═══════════════════════════════════════════════════════════
 
Spanish and Catalan receipts are printed in dot-matrix or thermal font.
OCR frequently confuses these character pairs. Apply ALL corrections BEFORE
transcribing any line:
 
── DIGIT / LETTER SWAPS ──────────────────────────────────
  O ↔ 0   (capital O misread as zero, or zero as O)
  I ↔ 1   (capital I misread as 1, or 1 as l/I)
  l ↔ 1   (lowercase l misread as 1)
  S ↔ 5   (S misread as 5, e.g. "5ALAMI" → "SALAMI")
  B ↔ 8   (B misread as 8, e.g. "8OQUIL" → "BOQUIL")
  G ↔ 6   (G misread as 6 in some fonts)
  Z ↔ 2   (Z misread as 2)
  D ↔ 0   (D misread as 0 in degraded print)
 
── LIGATURE / FUSED CHARACTER SWAPS ──────────────────────
  rn → m  (two separate chars 'r'+'n' fused into 'm', e.g. "arnb" → "amb")
  m → rn  (vice versa: 'm' split into 'r'+'n')
  ll → H  (Catalan double-l "ll" misread as H, e.g. "POHASTRE" → "POLLASTRE")
  H → ll  (H misread as ll, e.g. "POHASTRE" could be "POLLASTRE")
  cl → d  ('c'+'l' fused into 'd')
  d → cl  (vice versa)
  vv → w  (two v's fused)
  i → í   (missing accent in Catalan words common)
  · → l·l (Catalan "l·l" often loses the middle dot, printed as "LL" or "L·L")
 
── CATALAN / SPANISH DIACRITIC RECOVERY ──────────────────
  When a word looks like broken Catalan or Spanish, attempt to recover the
  correct diacritic form. Common recoveries:
    MORTADEL·LA   (never "MORTADELLA" or "MORTADEL-LA")
    POLLASTRE     (never "POHASTRE" or "P0LLASTRE")
    LLAMINADURA   (never "HAMINADURA" or "LLAM1NADURA")
    GALETA        (never "6ALETA")
    MONGETA       (never "M0NGETA")
    BROQUIL       (never "8ROQUIL" or "BR0QU1L")
    BACALLÀ       (à is often lost → "BACALLA")
    PRÉSSEC       (é lost → "PRESSEC")
    PÈSOLS        (è lost → "PESOLS")
    MADUIXOT      (confirm "MADUI XOT" or "MADUI-XOT" are the same word)
 
── PRICE FIELD CORRUPTION ────────────────────────────────
  Prices in Spanish/Catalan receipts use comma as decimal separator.
  OCR may corrupt them as follows — correct before reading any price:
    "1.25"  → "1,25"   (period misread as comma decimal → restore comma)
    "l,25"  → "1,25"   (lowercase l misread as digit 1)
    "l.2B"  → "1,28"   (compound corruption)
    "-0,"   → partial price; concatenate with next line to form full value (e.g. "-0,90")
    "O,8O"  → "0,80"   (letter O instead of zero)
    ","     alone on a line → decimal continuation from previous line
  RULE: A comma at the end of a price always means the decimal part is on the next line.
  RULE: Prices are ALWAYS positive floats (or negative for discounts). If a price
        contains a letter (except for unit suffix like "€/kg"), it is corrupted — fix it.
 
── UNIT / SUFFIX TOKENS ──────────────────────────────────
  These tokens appear in weight lines and must NOT be confused with product names:
    "kg"  "KG"  "€/kg"  "€/KG"  "Kg"
  A line containing ONLY these tokens plus numbers is a WEIGHT LINE (see Rule 6),
  not a product name.
 
── RECEIPT HEADER TOKENS (never product names) ───────────────
  Exclude these from Pass 1 product lines:
    "Descripció"  "P. Unit"  "Imp.(€)"  (column headers)
    "ENTRADA"  "SORTIDA"  (parking timestamps)
    "IVA"  "BASE IMPOSABLE"  "QUOTA"  "TOTAL"
    "TARG BANCARIA"  "MASTERCARD"  "VISA"  "EFECTIU"
    "N.C."  "AUT."  "AID:"  "ARC:"  "Verificat per dispositiu"
    "DISPOSA DE 20 MINUTS"  "PER RETIRAR EL SEU VEHICLE"
    Any line starting with "A-"  "N.C."  "AID:"  (receipt reference codes)
 
After applying all corrections above, proceed to Pass 1.
 
═══════════════════════════════════════════════════════════
PASS 1 — RAW TRANSCRIPTION (_1_transcripcion_bruta)
═══════════════════════════════════════════════════════════
 
Transcribe EVERY product line from the receipt image, top to bottom, into the
"_1_transcripcion_bruta" array. Apply OCR corrections from Pre-Pass 0.
 
STRICT RULES:
- One printed line = one array element. NEVER merge two lines into one element.
- NEVER skip any line. Include ALL lines that contain a price or a kg weight.
- If the same product name appears twice, write BOTH as separate elements.
- For two-line produce items: the product NAME is one element. The weight/price
  breakdown line immediately below it is the NEXT separate element. TWO elements.
- Stop at the TOTAL line (do not include it or anything below it).
- Do NOT include column header lines ("Descripció", "P. Unit", "Imp.(€)").
- Do NOT include parking entries of any kind.
 
⚠ CRITICAL AFTER PASS 1 — DUPLICATE SANDWICH PRE-SCAN:
Before doing anything else, scan _1_transcripcion_bruta for any product name
that appears more than once.
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
  "ocr_corrections_applied": [
    "List every OCR correction made in Pre-Pass 0, one per entry.",
    "Format: 'Line N: RAW → CORRECTED (reason: char swap O↔0 / ligature rn→m / etc.)'"
  ],
  "estado": "? (OK if diferencia <= 0.05, else REVISAR with explanation)"
}
 
═══════════════════════════════════════════════════════════
PASS 3 — STRUCTURED EXTRACTION (productos array)
═══════════════════════════════════════════════════════════
 
Build productos strictly in order using _1_transcripcion_bruta as the source of truth.
 
🔧 PRICE ANCHOR RULE:
Before writing each product object, state internally:
  "I am processing index N: '<raw line>'. The price on THIS line is X.XX €."
Then write the product object using ONLY the price from that exact line.
Do NOT carry over, borrow, or re-use the price from the previous or next line.
 
🔧 SANDWICH PROTOCOL (mandatory sequence for every duplicate pair):
When you encounter index_first (the first duplicate), follow this EXACT sequence:
 
  STEP 1 — Write the FIRST duplicate object using the price on index_first's line.
  STEP 2 — For each sandwiched line (index_first+1 … index_last-1), in order:
    a) Quote the raw line: "Line N text: '…'"
    b) Read the price from THAT EXACT LINE: "Price on this line: X.XX"
    c) Write the product object using ONLY that price.
  STEP 3 — Write the SECOND duplicate object using the price on index_last's line.
  STEP 4 — State: "Sandwich complete. Written N items between the two duplicates."
    If N ≠ N_sandwich from Pass 1, STOP and find the missing item(s).
 
After every 5 products written, perform a SPOT CHECK:
- Read the last 5 entries in productos.
- Verify that the precio matches the price printed on its source line.
- Fix any mismatch immediately before continuing.
 
═══════════════════════════════════════════════════════════
PASS 4 — MANDATORY SELF-AUDIT
═══════════════════════════════════════════════════════════
 
CHECK A — COUNT MATCH
  len(productos) must equal total_lineas_producto.
  If they differ: find the missing lines and add them.
 
CHECK B — DUPLICATE SANDWICH AUDIT
  For every pair in duplicados_detectados:
  1. Find both objects in productos.
  2. List every object between them.
  3. Cross-reference with items_entre_duplicados item by item.
  4. For each entry: mark ✓ PRESENT or ✗ MISSING → insert if missing.
  5. Confirm (products between duplicates) == N_sandwich.
  6. PRICE CHECK on all sandwich items: verify precio matches source line exactly.
 
CHECK C — PRICE VERIFICATION (line-by-line)
  For EVERY product in productos:
  1. Locate its source line in _1_transcripcion_bruta.
  2. Extract the unit price on that exact line.
  3. Confirm it matches productos[i].precio exactly.
  Fix any mismatch before continuing.
  Pay special attention to consecutive items with similar prices (e.g. 1.20 vs 1.80).
 
CHECK C2 — OCR PRICE SANITY
  For each precio value, verify:
  - It is a valid positive float (negative only for discounts/Descuento category).
  - It does not contain letters (e.g. "l,25" would be an unfixed OCR error).
  - It is plausible for the product type (e.g. a single yogurt costing 15€ is suspect).
  Fix any corrupted price before continuing.
 
CHECK D — SUBTOTAL CROSS-CHECK
  For every non-produce product:
    expected_subtotal = cantidad × precio
    Compare to the printed subtotal on that source line (tolerance: 0.01€).
    If mismatch: the precio is WRONG. Re-read and correct.
 
CHECK E — SUM CHECK
  suma_calculada = sum of all (cantidad × precio) in productos.
  diferencia_euros = abs(total_tiquet - suma_calculada).
  If diferencia_euros > 0.05€:
    Step 1: Re-run CHECK B (missing sandwich item most likely).
    Step 2: Re-run CHECK C (misread price).
    Step 3: Re-count total_lineas_producto vs len(productos). Add missing.
    Step 4: Fix all errors. Recalculate until diferencia_euros <= 0.05.
  Set estado = "OK" only when diferencia_euros <= 0.05.
 
═══════════════════════════════════════════════════════════
PASS 5 — FINAL NUMERICAL RECONCILIATION
═══════════════════════════════════════════════════════════
 
  1. Sort productos by their source index.
  2. Walk _1_transcripcion_bruta from index 0 to the last product line.
  3. For each line containing a price (comma-decimal like "1,25"):
     - Confirm a product object exists whose precio matches and position corresponds.
     - If no match: the line was SKIPPED. Create and insert the product object.
  4. Recalculate suma_calculada and diferencia_euros.
  5. Update _2_verificacion and set estado = "OK" if diferencia <= 0.05.
 
═══════════════════════════════════════════════════════════
FULL JSON STRUCTURE
═══════════════════════════════════════════════════════════
 
{
    "_1_transcripcion_bruta": [ ... ],
    "_2_verificacion": { ... },
    "supermercado": "Extract the commercial brand name ONLY if explicitly printed (e.g. 'MERCADONA', 'LIDL', 'CARREFOUR', 'BONPREU', 'CONSUM'). Output \"Desconocido\" if the header contains ONLY: address, postal code, city name, phone number, tax ID (CIF/NIF starting with A-, B-, etc.), invoice number, or combinations of these with NO recognisable retail brand name. Do NOT infer the chain from address or phone. NEGATIVE EXAMPLES → \"Desconocido\": '08911 BADALONA', 'C/ SEU D\\'URGELL 44', '938347360', 'A-46103834', 'FACTURA SIMPLIFICADA: 4176-013-400798'.",
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
   - After OCR correction (Pre-Pass 0), all prices must be clean floats.
 
2. ANTI-SHIFTING — PROCESS ONE ITEM AT A TIME
   - Work through _1_transcripcion_bruta strictly in order.
   - For each non-produce item: read the name and price on the same line, write the
     product object, then move to the next line.
   - For each two-line produce item: read the name line, then IMMEDIATELY read the
     next line for weight/price data, write the complete product object, then advance.
   - After every 5 products, verify the last price matches the receipt line exactly.
 
3. DUPLICATE PRODUCT NAMES
   - If the same name appears twice, create TWO separate product objects with their
     respective (potentially different) prices.
   - ALL items in _2_verificacion.items_entre_duplicados must appear as product objects
     between the two duplicates. Verify explicitly in Pass 4 / CHECK B.
 
4. QUANTITY > 1 AND TWO-COLUMN PRICES
   - Format: [QTY] [ITEM NAME] [UNIT PRICE] [LINE TOTAL]
   - Always extract UNIT PRICE (first price), never the line total.
   - "2 TRUITA PATATA/CEBA 2,80 5,60" → cantidad:2, precio:2.80
   - "6 PANET LLAVORS 0,35 2,10"      → cantidad:6, precio:0.35
   - "2 TOMAQUET TRITURAT 1,00 2,00"  → Alimentacion, cantidad:2, precio:1.00
   - "2 MONGETA BLANCA CUITA 0,80 1,60" → Alimentacion, cantidad:2, precio:0.80
 
5. CATEGORY "Fruta/Verdura" — THE KG TEST (mandatory before every categoria assignment)
   Ask: "Does THIS line, or the line immediately below it, contain 'kg' or 'KG'
         AND a price-per-kg rate (€/kg or X,XX €/kg)?"
   ▶ YES → categoria: "Fruta/Verdura"
   ▶ NO  → categoria: "Alimentacion" (or appropriate non-produce category)
            The product's name is irrelevant — only the kg notation matters.
            A broccoli sold as "1 BROQUIL 2,00" WITHOUT kg notation = Alimentacion.
 
   ✅ Fruta/Verdura — the ONLY two valid receipt patterns:
      FORMAT A — name on line N (no price), weight+price on line N+1:
        "1 MANDARINA" / "1,428 kg  2,35 €/kg  3,36"
        → cantidad:1.428, precio:2.35, categoria:"Fruta/Verdura"
 
      FORMAT B — name + weight + total on one line:
        "1 MADUIXOT 1,3 KG 3,21"
        → cantidad:1.3, precio:3.21÷1.3=2.47, categoria:"Fruta/Verdura"
 
   ❌ Alimentacion — these exact patterns are NOT Fruta/Verdura:
      "1 BROQUIL 2,00"               → Alimentacion, cantidad:1, precio:2.00
      "1 TOMAQUET NATURAL RAT 1,00"  → Alimentacion, cantidad:1, precio:1.00
      "1 MONGETA RODONA A TR 1,45"   → Alimentacion, cantidad:1, precio:1.45
 
6. MULTI-LINE PRODUCE — THE ANCHOR RULE
   FORMAT A — Two separate lines:
     Line N:   "1 MANDARINA"              ← product name (ignore the "1")
     Line N+1: "1,428 kg 2,35 €/kg 3,36" ← weight/price line
     → cantidad:1.428, precio:2.35
     → IGNORE "1" on name line. IGNORE line total 3.36.
 
   FORMAT B — Single line with weight embedded:
     "1 MADUIXOT 1,3 KG 3,21"
     → rightmost number = LINE TOTAL (NOT unit price)
     → cantidad = kg weight = 1.3
     → precio = line_total ÷ weight = 3.21 ÷ 1.3 = 2.47
     → Remove weight notation from product name: "Maduixot"
     ⚠ NEVER set cantidad=1 and precio=line_total for FORMAT B. Always wrong.
 
   THE ANCHOR RULE: Weight on Line N+1 belongs to the product on Line N.
   List all pairs in _2_verificacion.produce_pairs_confirmed BEFORE building productos.
 
   ANTI-CASCADE CHECK FOR PRODUCE: After writing each produce item, verify:
     - cantidad matches the kg on THAT item's weight line (not the next item's).
     - precio matches the €/kg on THAT item's weight line (not the next item's).
   State explicitly: "BANANA: using its OWN weight line (index N+1): X kg × Y €/kg"
 
7. PRODUCT NAME FORMATTING (Catalan / Spanish abbreviation expansion)
   Apply ALL of the following expansions (receipt → clean name):
 
   CATALAN EXPANSIONS:
     "POHASTRE" / "P0LLASTRE"  → "Pollastre"        (OCR ll→H fix)
     "MORTADEL-LA" / "MORTADELLA" → "Mortadel·la"   (Catalan geminated l)
     "HAMINADURA"               → "Llaminadura"      (OCR H→ll fix)
     "ASSORTID" / "ASSORTIDA"   → "Assortida"
     "AVEN I SEMI"              → "Avena i Semilles"
     "FARCIDA" / "FARCIT"       → "Farcida" / "Farcit"
     "CONF." / "CONFERENCIA"    → "Conferència"
     "BROQUIL" / "BROQUIT"      → "Bròquil"
     "MONGETA"                  → "Mongeta"          (confirm, not "M0NGETA")
     "GALETA"                   → "Galeta"           (confirm, not "6ALETA")
     "PANET"                    → "Panet"
     "LLAVORS"                  → "Llavors"
     "CARBASSO" / "CARBASSÓ"    → "Carbassó"
     "MADUIXOT"                 → "Maduixot"
     "TRUITA"                   → "Truita"
     "TIQUET" / "TIQUETS"       → never a product
     "TAURO" / "TAURÓ"          → "Tauró"
     "TOMAQUET" / "TOMÀQUET"    → "Tomàquet"
     "PEBROT"                   → "Pebrot"
     "PERLES" / "PERLS"         → "Perles"
 
   SPANISH / GENERAL EXPANSIONS:
     "INTEG." / "INTEG"         → "Integral"
     "S/G"                      → "Sense Greix" (Catalan) or "Sin Grasa" (Spanish)
     "S/SUR"                    → "Sense Surimi"
     "EMP"                      → "Empanada"
     "MORTADEL·LA GALL"         → "Mortadel·la de Gall d'Indi"
     "LLAMIN."                  → "Llaminadura"
     "PAT."                     → "Patates"
     "FIL DENTAL"               → "Fil Dental"
     "DENTIFRIC"                → "Dentífric"
     "CREMA SUAVITZ."           → "Crema Suavitzant"
     "COCKTAIL TOST."           → "Cocktail Torrades"
     "SALAMI PACK"              → "Salami Pack"
     "BROQUETA"                 → "Brocheta" (or "Broqueta" in Catalan)
     "MAIONESA"                 → "Maionesa"
     "LLONZA" / "LLONÇA"        → "Llonza de Porc"
     "PORCIONS"                 → "Porcions"
     "BOMBÓ"                    → "Bombó"
     "HELICES" / "HÈLICES"      → "Hèlices"
     "FUET"                     → "Fuet"
     "COLA ZERO"                → "Cola Zero"
     "NACHOS"                   → "Nachos"
     "TORTILLES"                → "Tortilles"
     "P-4" / "P 4"              → "Pack 4"
     "F. BURGOS"                → "Fromage de Burgos"  (or "Queso de Burgos")
     "XICLET"                   → "Xiclet"
     "TAMPAX COMPAK"            → "Tampax Compak"
     "FORMATGE"                 → "Formatge"
     "EMMENTAL"                 → "Emmental"
     "FRESI PINK"               → "Fresi Pink"
     "BOCA FRUIT"               → "Boca Fruit"
     "FILET"                    → "Filet"
     "ARROS" / "ARRÒS"          → "Arròs"
     "DELICIES" / "DELÍCIES"    → "Delícies"
     "CRACKERS"                 → "Crackers"
     "SNACK PIPES"              → "Snack Pipes"
     "COOKIES"                  → "Cookies"
     "MARIES" / "MARÍAS"        → "Galetes Maries"
     "HELADOS" / "GELATS"       → "Gelats"
     "P. PAV. RED."             → "Pa Pavot Rodó"
     "P. COLORCOR"              → "Pa Colorcor"
     "FIL DENTAL PACK"          → "Fil Dental Pack"
     "ULTR.WHITE ENER." / "ULTR. WHITE" → "Monster Ultra White"
     "ENER." → "Energy"
 
   GENERAL RULES:
   - Remove trailing isolated tax indicator characters: " O", " A", " B", " *" from name end.
   - Remove weight notation from produce names (e.g. "1,3 KG" removed from "Maduixot 1,3 KG").
   - Use Title Case for all product names.
   - Preserve Catalan characters: à, è, é, í, ï, ó, ò, ú, ü, ç, l·l.
   - PRESERVE PUNCTUATION: Do NOT remove dots (.), slashes (/), or hyphens (-) from product names unless explicitly told to in the expansions. If a word is truncated with a dot (e.g., "ULTR."), keep the dot if you cannot expand it.
 
8. ABSOLUTE EXCLUSIONS (NEVER create a product object for these)
   - Parking: "PARQUING", "TICKET PARKING", "ENTRADA", "SORTIDA", any variant.
     Also exclude the parking timestamp line ("ENTRADA 16:53 SORTIDA 17:38").
   - Items with final printed price = exactly 0.00.
   - Payment lines: "TARGETA BANCARIA", "MASTERCARD", "VISA", "EFECTIU", "METÀLIC".
   - VAT/tax lines: "IVA", "BASE IMPOSABLE", "QUOTA".
   - Change lines: "EL SEU CANVI", "SU CAMBIO", "CANVI".
   - Receipt reference lines: "N.C.", "AUT.", "AID:", "ARC:", "Verificat per dispositiu".
   - Column headers: "Descripció", "P. Unit", "Imp.(€)".
   - Footer text: "DISPOSA DE 20 MINUTS", "PER RETIRAR EL SEU VEHICLE".
   - Any line starting with "A-" (receipt ID), "FACTURA SIMPLIFICADA".
   Do NOT include excluded items in total_lineas_producto count.
 
9. DISCOUNTS AND PROMOTIONS
   - Discount lines (price is negative) → categoria: "Descuento", precio as negative float.
   - Never use 0.00 as a discount price; if the discount is zero, exclude the line entirely.
   - Descriptive name: use what is printed (e.g. "Descuento 2a Unitat", "Descompte Fidelitat").
 
10. PAYMENT METHOD
    - "TARGETA BANCARIA", "MASTERCARD", "VISA", "CONTACTLESS" → "Tarjeta"
    - "EFECTIU", "METÀLIC", "EFECTIVO" → "Efectivo"
    - Ambiguous or absent → "Otros"
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