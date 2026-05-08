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
Eres un Analista de Datos Retail y Contable Experto. Tu objetivo es extraer la información de la imagen del recibo (tiquet) y estandarizarla en un formato JSON.

INSTRUCCIÓN CRÍTICA: Devuelve ÚNICAMENTE un objeto JSON en bruto. SIN markdown (```json), SIN explicaciones.

REGLAS DE EXTRACCIÓN (Formato Mercadona) - ¡PROHIBICIONES ABSOLUTAS!:

1. EL ERROR DE LA MULTIPLICACIÓN (Cantidades Múltiples):
   - Las líneas con más de un artículo tienen DOS precios. Ej: "2 TRUITA PATATA/CEBA 2,80 5,60".
   - El primer número (2,80) es el PRECIO UNITARIO. El último (5,60) es el SUBTOTAL.
   - -> EXTRAE SIEMPRE EL PRECIO UNITARIO (2.80). Si pones 5.60, el sistema multiplicará 2 x 5.60 y arruinará la contabilidad.
   - Igual para "2 TOMAQUET TRITURAT 1,00 2,00" -> Cantidad: 2. Precio: 1.00.

2. EL ERROR DEL MADUIXOT (Artículos a peso en 1 sola línea):
   - Si la línea dice "1 MADUIXOT 1,3 KG 3,21", el 3,21 es el PRECIO TOTAL. Para que el sistema funcione, DEBES DIVIDIR el total entre el peso para obtener el precio unitario.
   - Cálculo interno que debes hacer: 3.21 / 1.3 = 2.47 €/kg.
   - Tu JSON debe ser -> Cantidad: 1.3, Precio: 2.47, Categoría: "Fruta/Verdura".

3. LA REGLA DEL BRÓCOLI Y LA CATEGORÍA:
   - "1 BROQUIL 2,00". Si NO aparece la palabra "kg" LITERALMENTE escrita junto al producto, se trata de 1 unidad cerrada.
   - -> Su categoría DEBE SER "Alimentacion" (¡NUNCA "Fruta/Verdura"!). 
   - Solo los artículos donde se imprimen explícitamente los "kg" van en "Fruta/Verdura".

4. FRUTA PESADA EN DOS LÍNEAS (¡No duplicar!):
   - "1 MANDARINA" y debajo "1,428 kg 2,35 €/kg 3,36" -> FUSIONA AMBAS LÍNEAS EN UN SOLO PRODUCTO.
   - Cantidad: 1.428, Precio: 2.35, Categoría: "Fruta/Verdura". Ignora el "1" inicial y el total de 3.36.

5. NÚMEROS EN NOMBRES Y LÍNEAS BASURA:
   - "1 12 OUS GRANS L 3,20" -> Cantidad: 1. Producto: "12 Ous Grans L". Precio: 3.20.
   - IGNORA COMPLETAMENTE Y NO INCLUYAS: "PARQUING", "ENTRADA", "SORTIDA", "TOTAL","METALICO", tarjetas de crédito y líneas con precio 0.00€.

ESTRUCTURA JSON REQUERIDA:
{
  "_razonamiento": "1. Múltiples unidades: Extraeré solo el primer precio (Unitario) para evitar que la base de datos lo multiplique doble. 2. Maduixot: Calcularé precio total/kilos (3.21/1.3=2.47). 3. Brócoli: Como no tiene 'kg' impreso, le pongo cantidad 1 y categoría 'Alimentacion'. 4. No duplicaré las frutas pesadas ni incluiré el Parking.",
  "supermercado": "Nombre de la marca (ej. MERCADONA)",
  "fecha_tiquet": "YYYY-MM-DD HH:MM",
  "total_tiquet": 0.00,
  "metodo_pago": "Efectivo, Tarjeta, u Otros",
  "productos":[
    {
      "cantidad": 1.000,
      "marca": "Generica",
      "producto": "Nombre Limpio",
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