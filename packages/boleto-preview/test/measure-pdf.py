"""Optional geometric QA of the two synthetic HTML-to-PDF print specimens.

Requires local pdfplumber; no downloads, browser, network or PDF mutations.
Usage: python measure-pdf.py standard.pdf dense.pdf
"""
import json
import sys
import pdfplumber

if len(sys.argv) != 3:
    raise SystemExit("Expected the standard and dense synthetic PDFs")

results = []
for path in sys.argv[1:]:
    with pdfplumber.open(path) as document:
        assert len(document.pages) == 1, "Expected one page"
        page = document.pages[0]
        mm = lambda points: points * 25.4 / 72
        assert abs(mm(page.width) - 210) < 0.2 and abs(mm(page.height) - 297) < 0.2
        assert (page.extract_text() or "").count("NÃO PAGAR") >= 5
        bars = [r for r in page.rects if abs(mm(r["height"]) - 13) < 0.1 and r["top"] > 700 and r["width"] < 3]
        boxes = [r for r in page.rects if abs(mm(r["width"]) - 113) < 0.1 and abs(mm(r["height"]) - 24) < 0.1]
        assert len(bars) == 114 and len(boxes) == 1, "Unexpected barcode geometry"
        box = boxes[0]
        left, right = min(r["x0"] for r in bars), max(r["x1"] for r in bars)
        top, bottom = min(r["top"] for r in bars), max(r["bottom"] for r in bars)
        width, height = mm(right - left), mm(bottom - top)
        quiet_left, quiet_right = mm(left - box["x0"]), mm(box["x1"] - right)
        # SVG starts at the top of the 28 mm footer, with its own height 24 mm.
        center_from_bottom = mm(box["top"] + box["height"] * 28 / 24 - (top + bottom) / 2)
        assert abs(width - 103) < 0.1 and abs(height - 13) < 0.1
        assert abs(quiet_left - 5) < 0.1 and abs(quiet_right - 5) < 0.1
        assert center_from_bottom >= 12 and abs(center_from_bottom - 13.5) < 0.1
        results.append({"fixture": "standard" if len(results) == 0 else "dense", "pages": 1, "bars": 114,
                        "barcode_width_mm": round(width, 4), "barcode_height_mm": round(height, 4),
                        "quiet_left_mm": round(quiet_left, 4), "quiet_right_mm": round(quiet_right, 4),
                        "barcode_center_from_bottom_mm": round(center_from_bottom, 4)})
print(json.dumps(results, ensure_ascii=False))
