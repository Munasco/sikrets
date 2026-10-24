# Generates the landing page renders with Gemini image models. Original art, one shared look:
# matte black hardware, sage-green rim light, studio product photography. Re-run to regenerate:
#   python3 scripts/gen-images.py [name ...]
import base64, json, os, sys, urllib.request, urllib.error, concurrent.futures as cf

KEY = os.environ["GEMINI_API_KEY"]
MODEL = os.environ.get("IMAGE_MODEL", "gemini-3-pro-image")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "landing")

LOOK = ("Premium studio product photography, dark and minimal. Pure near-black background (#0c0e0d) fading to black at the edges. "
        "Matte black anodized metal and brushed dark steel. A single soft sage-green (#9ca99a) rim light and a faint cool top light; "
        "deep shadows, subtle film grain, shallow depth of field, photorealistic, high detail. "
        "No text, no letters, no logos, no brand marks, no people, no screens with writing.")

IMAGES = {
    "hero-key": ("16:9", "A large block of speckled grey concrete placed diagonally across the frame, running from the lower left toward the upper right, "
                 "its top face lit by a soft wide beam of light coming down from the upper left through darkness. Resting on the top face of the block, "
                 "a slim matte-black anodized metal hardware security key (a sleek USB-style token with a small loop at one end), with one tiny sage-green "
                 "status light glowing on it. The right two thirds of the frame hold the block and key; the left third is mostly dark empty space. "
                 "Mostly monochrome: black, charcoal and concrete grey, with the sage light as the only colour."),
    "hero": ("16:9", "A tall, monolithic matte-black metal block resting on a dark textured stone surface, seen at a three-quarter angle. "
             "A single narrow precision-machined key slot is cut into its face and glows softly from inside with sage-green light. "
             "Fine dust particles hang in a beam of light from above. Calm, heavy, secure."),
    "vault": ("4:3", "A thick circular vault door in matte black steel, open a few centimetres, with sage-green light spilling out through the gap "
              "onto a dark floor. Precision bolts along the edge. Seen slightly from the side."),
    "standin": ("4:3", "Two keys lying side by side on dark slate: on the left a real key in brushed dark steel, on the right an identical key "
                "made of frosted, slightly translucent glass that catches a faint sage-green light. Top-down angle, elegant composition."),
    "rotate": ("4:3", "A single brushed dark-steel key floating in dark space, captured mid-rotation, with a thin circular trail of sage-green light "
               "sweeping around it like a long-exposure arc. Minimal, precise."),
}

def gen(name):
    aspect, scene = IMAGES[name]
    body = {"contents": [{"parts": [{"text": f"{scene}\n\n{LOOK}"}]}],
            "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": aspect}}}
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
                                 data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": KEY})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=600))
    except urllib.error.HTTPError as e:
        return name, f"HTTP {e.code} {e.read().decode()[:300]}"
    for part in d.get("candidates", [{}])[0].get("content", {}).get("parts", []):
        if "inlineData" in part:
            ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(part["inlineData"]["mimeType"], "png")
            path = os.path.join(OUT, f"{name}.{ext}")
            open(path, "wb").write(base64.b64decode(part["inlineData"]["data"]))
            return name, path
    return name, f"no image: {json.dumps(d)[:300]}"

os.makedirs(OUT, exist_ok=True)
with cf.ThreadPoolExecutor(4) as ex:
    for name, result in ex.map(gen, sys.argv[1:] or list(IMAGES)):
        print(name, "→", result)
