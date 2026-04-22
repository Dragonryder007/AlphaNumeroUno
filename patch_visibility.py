import os
import re

directory = r"c:\Users\admin\Desktop\projects\Numer"
files = ["final-index.html", "final-audit.html", "final-services.html", "final-clients.html"]

fixes = {
    # 1. Add --yellow to :root to fix the announce bar background
    "--orange:#D4AF37;--fh:": "--yellow:#D4AF37;--orange:#D4AF37;--fh:",
    
    # 2. Fix the announce bar links to be black (since background is now gold)
    ".ann a{color:#F5F5F5": ".ann a{color:#000000",
    
    # 3. Brighten nav links from --tx2 (#CCCCCC) to --tx (#F5F5F5)
    ".nav-links a{font-size:13px;color:var(--tx2);": ".nav-links a{font-size:14px;color:var(--tx);",
    
    # 4. Brighten the WhatsApp button. Was transparent rgba(212,175,55,.10) -> Let's make it solid secondary #1F1F1F with gold border and brighter text
    ".nav-wa{display:flex;align-items:center;gap:6px;background:rgba(212,175,55,.10);border:1px solid rgba(212,175,55,.18);color:#D4AF37;":
    ".nav-wa{display:flex;align-items:center;gap:6px;background:#1F1F1F;border:1px solid #D4AF37;color:#D4AF37;font-weight:700;",
    
    # Hover for WhatsApp button
    ".nav-wa:hover{background:rgba(212,175,55,.18);color:#D4AF37}":
    ".nav-wa:hover{background:#D4AF37;color:#000000}",
    
    # 5. Brighten the CTA AI Audit button gradient. The previous #B38F24 made it muddy brown.
    ".nav-cta{background:linear-gradient(135deg,#D4AF37,#B38F24);color:#000;":
    ".nav-cta{background:linear-gradient(135deg,#F1D06F,#D4AF37);color:#000000;",
    
    ".nav-cta:hover{background:linear-gradient(135deg,#B38F24,#D4AF37);color:#000}":
    ".nav-cta:hover{background:linear-gradient(135deg,#D4AF37,#F1D06F);color:#000000}",
    
    # 6. Button classes (hero)
    ".btn-lime{background:linear-gradient(135deg,#D4AF37,#B38F24);":
    ".btn-lime{background:linear-gradient(135deg,#F1D06F,#D4AF37);",
    
    ".btn-lime:hover{background:var(--lime2);":
    ".btn-lime:hover{background:#D4AF37;",

    ".btn-ghost{background:transparent;color:var(--wht);padding:14px 24px;border-radius:7px;font-size:14px;font-weight:500;text-decoration:none;border:1px solid var(--bd);":
    ".btn-ghost{background:transparent;color:#D4AF37;padding:14px 24px;border-radius:7px;font-size:14px;font-weight:600;text-decoration:none;border:1px solid #D4AF37;",

    ".btn-ghost:hover{border-color:rgba(255,214,0,.3);color:var(--lime)}":
    ".btn-ghost:hover{border-color:#F1D06F;background:rgba(212,175,55,.1);color:#F1D06F}"
}

for filename in files:
    path = os.path.join(directory, filename)
    if not os.path.exists(path):
        continue
    
    with open(path, 'r', encoding='utf-8') as file:
        content = file.read()
        
    for old, new in fixes.items():
        content = content.replace(old, new)
        
    with open(path, 'w', encoding='utf-8') as file:
        file.write(content)

print("Visibility patches applied.")
