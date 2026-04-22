import os
import re

directory = r"c:\Users\admin\Desktop\projects\Numer"

replacements = {
    # CSS variables block mapping
    "--blk:#060E10;--wht:#EEF8F6;--lime:#2DD4C8;--lime2:#8EB69B;": "--blk:#0A0A0A;--wht:#F5F5F5;--lime:#D4AF37;--lime2:#B38F24;",
    "--g1:#0C2224;--g2:#132E30;--mt:#4A7470;": "--g1:#1F1F1F;--g2:#000000;--mt:#A3A3A3;",
    "--bd:rgba(45,212,200,.12);--tx:#D4EDEA;--tx2:#7AACA6;": "--bd:rgba(212,175,55,.12);--tx:#F5F5F5;--tx2:#CCCCCC;",
    "--orange:#8EB69B;": "--orange:#D4AF37;",

    # Direct hex code replacements
    "#2DD4C8": "#D4AF37", # Gold
    "#8EB69B": "#B38F24", # Dark Gold
    "#060E10": "#0A0A0A", # Black bg
    "#0C2224": "#1F1F1F", # Secondary
    "#132E30": "#000000", # Primary
    "#EEF8F6": "#F5F5F5", # White text
    "#4A7470": "#A3A3A3", # Muted
    "#D4EDEA": "#F5F5F5", # Text
    "#7AACA6": "#CCCCCC", # Secondary Text

    # rgba instances
    "45,212,200": "212,175,55", # Gold rgb
    "142,182,155": "179,143,36", # Dark gold rgb
    "12,34,36": "31,31,31", # #1F1F1F as rgb

    # Gradients might need careful replacement if they don't exactly match hex
    # 'linear-gradient(135deg,#2DD4C8,#8EB69B)' -> 'linear-gradient(135deg,#D4AF37,#B38F24)' is covered by the hex replacements!
}

files_to_update = ['final-index.html', 'final-audit.html', 'final-services.html', 'final-clients.html']

for filename in files_to_update:
    filepath = os.path.join(directory, filename)
    if not os.path.exists(filepath):
        print(f"Skipping {filename}, not found.")
        continue
        
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
        
    for old, new in replacements.items():
        content = content.replace(old, new)
        
    # Also adjust the "Yellow" announcement bar if any
    # It seems there's an announcement bar background var(--yellow) which isn't defined in root, wait... is it?
    # Actually var(--yellow) might not be in root, but let's replace #FFD700 or similar if it exists.
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Updated {filename}")
