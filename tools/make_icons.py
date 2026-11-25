"""Generate the PNG app icons for 릴스 컷 스튜디오 from the same shapes as icon.svg."""
from PIL import Image, ImageDraw
import os

S = 1024
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, stops):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        if t < 0.55:
            c = lerp(stops[0], stops[1], t / 0.55)
        else:
            c = lerp(stops[1], stops[2], (t - 0.55) / 0.45)
        d.line([(0, y), (size, y)], fill=c)
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_icon(pad_ratio=0.0):
    """pad_ratio shrinks the artwork for maskable icons."""
    base = gradient(S, [(255, 244, 238), (253, 227, 234), (243, 220, 239)])
    art = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)
    k = 1 - pad_ratio
    off = S * pad_ratio / 2

    def X(v):
        return off + v * k

    def box(x0, y0, x1, y1):
        return [X(x0), X(y0), X(x1), X(y1)]

    # film strip body
    d.rounded_rectangle(box(172, 224, 852, 800), radius=104 * k, fill=(62, 48, 72))
    # sprocket holes
    for y in (292, 432, 572, 712):
        for x in (224, 764):
            d.rounded_rectangle(box(x, y, x + 36, y + 52), radius=14 * k, fill=(255, 244, 238))
    # play triangle
    d.polygon(
        [(X(428), X(372)), (X(636), X(500)), (X(428), X(628))],
        fill=(233, 145, 174),
    )
    # scissors badge
    cx, cy, r = 732, 748, 148
    d.ellipse(box(cx - r, cy - r, cx + r, cy + r), fill=(255, 244, 238))
    r2 = 124
    d.ellipse(box(cx - r2, cy - r2, cx + r2, cy + r2), fill=(222, 126, 160))
    w = round(30 * k)
    cream = (255, 244, 238)
    pivot = (cx, cy + 8)
    # two blades opening upward
    d.line([(X(pivot[0]), X(pivot[1])), (X(cx - 62), X(cy - 58))], fill=cream, width=w)
    d.line([(X(pivot[0]), X(pivot[1])), (X(cx + 62), X(cy - 58))], fill=cream, width=w)
    # finger loops at the bottom
    for hx in (cx - 42, cx + 42):
        d.line([(X(pivot[0]), X(pivot[1])), (X(hx), X(cy + 56))], fill=cream, width=w)
        d.ellipse(box(hx - 28, cy + 42, hx + 28, cy + 98), outline=cream, width=round(20 * k))
    d.ellipse(box(pivot[0] - 11, pivot[1] - 11, pivot[0] + 11, pivot[1] + 11), fill=cream)

    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(base, (0, 0), rounded_mask(S, 232))
    icon.alpha_composite(art)
    return icon


def save(icon, name, size):
    icon.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))


master = draw_icon(0)
save(master, "icon-512.png", 512)
save(master, "icon-192.png", 192)
save(master, "apple-touch-icon.png", 180)

maskable = draw_icon(0.14)
save(maskable, "icon-maskable-512.png", 512)

preview = Image.new("RGB", (S, S), (253, 246, 242))
preview.paste(master, (0, 0), master)
preview.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "_preview.png"))
print("icons written to", OUT)
