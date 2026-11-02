import sys, json
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
# args: out.pdf  pagesJSON(list of list-of-lines)
out = sys.argv[1]
pages = json.loads(sys.argv[2])
c = canvas.Canvas(out, pagesize=A4)
W, H = A4
for page in pages:
    y = H - 60
    c.setFont("Helvetica", 11)
    for line in page:
        for seg in [line[i:i+95] for i in range(0, max(1, len(line)), 95)]:
            c.drawString(54, y, seg)
            y -= 16
            if y < 60:
                c.showPage(); c.setFont("Helvetica", 11); y = H - 60
    c.showPage()
c.save()
