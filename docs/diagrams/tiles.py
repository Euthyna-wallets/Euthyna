"""Hand-drawn 'tile' diagrams (dark rounded tiles, orange labels, teal arrows)."""
import sys, re, pathlib

CHAINS = pathlib.Path(__file__).resolve().parents[2] / 'apps/console/public/chains'
TILE = '#2D3137'
EDGE = '#22262B'
ORANGE = '#E8732A'
TEAL = '#3AA3B5'
BLUE = '#5AB0F0'
WHITE = '#F4F6F8'
GOLD = '#F2B544'
FONT = "'Comic Shanns', 'Comic Shanns Regular', monospace"

out = []


def text(x, y, s, size=15, color=ORANGE, anchor='middle', weight='normal'):
    out.append(f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" fill="{color}" text-anchor="{anchor}" font-weight="{weight}">{s}</text>')


def tile(cx, cy, w, h, icon, label=None, caption=None, border=None, r=16):
    x, y = cx - w / 2, cy - h / 2
    b = border or EDGE
    sw = 2.5 if border else 2
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{TILE}" stroke="{b}" stroke-width="{sw}"/>')
    s = min(w, h) / 100
    iy = cy - (10 * s if label else 0)
    out.append(f'<g transform="translate({cx},{iy}) scale({s})" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="{3.2}">{ICONS[icon]}</g>')
    if label:
        text(cx, y + h - 10, label, size=11 if w < 120 else 12.5)
    if caption:
        lines = caption.split('|')
        for i, line in enumerate(lines):
            text(cx, y + h + 22 + i * 19, line, size=16)


def mini(cx, cy, icon, size=40):
    out.append(f'<rect x="{cx-size/2}" y="{cy-size/2}" width="{size}" height="{size}" rx="8" fill="{TILE}" stroke="{EDGE}" stroke-width="1.5"/>')
    out.append(f'<g transform="translate({cx},{cy}) scale({size/100})" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="5">{ICONS[icon]}</g>')


def arrow(d, color=TEAL, dash=None, head=True, both=False, w=3):
    da = f' stroke-dasharray="{dash}"' if dash else ''
    m = ' marker-end="url(#ah)"' if head else ''
    ms = ' marker-start="url(#ahs)"' if both else ''
    out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linecap="round"{da}{m}{ms}/>')


def chain_logo(cx, cy, name, size=30):
    if name == 'ethereum':
        out.append(f'<g transform="translate({cx},{cy}) scale({size/30})"><path d="M0 -15 L-9 0 L0 5 L9 0 Z" fill="#8A92B2"/><path d="M0 7 L-9 2 L0 15 L9 2 Z" fill="#62688F"/><path d="M0 -15 L0 5 L9 0 Z" fill="#454A75"/></g>')
        return
    svg = (CHAINS / f'{name}.svg').read_text()
    vb = re.search(r'viewBox="([^"]+)"', svg).group(1).split()
    inner = re.sub(r'^.*?<svg[^>]*>|</svg>\s*$', '', svg, flags=re.S)
    vw, vh = float(vb[2]), float(vb[3])
    k = size / max(vw, vh)
    out.append(f'<g transform="translate({cx - vw*k/2},{cy - vh*k/2}) scale({k}) translate({-float(vb[0])},{-float(vb[1])})">{inner}</g>')


def chain_tile(cx, cy, name):
    out.append(f'<rect x="{cx-30}" y="{cy-30}" width="60" height="60" rx="12" fill="{TILE}" stroke="{ORANGE}" stroke-width="2.5"/>')
    chain_logo(cx, cy, name)


W, B = WHITE, BLUE
ICONS = {
    'robot': f'<rect x="-22" y="-26" width="44" height="30" rx="9" stroke="{W}"/><circle cx="-9" cy="-11" r="3.5" fill="{B}" stroke="{B}"/><circle cx="9" cy="-11" r="3.5" fill="{B}" stroke="{B}"/><path d="M0 -26 V-34" stroke="{W}"/><circle cx="0" cy="-37" r="3" stroke="{B}"/><path d="M-16 8 h32 v18 h-32 z" stroke="{W}"/><path d="M-22 12 l-8 10 M22 12 l8 10" stroke="{W}"/>',
    'robots': f'<g transform="translate(-31,8) scale(.55)"><rect x="-22" y="-26" width="44" height="30" rx="9" stroke="{W}"/><circle cx="-9" cy="-11" r="3.5" fill="{B}" stroke="{B}"/><circle cx="9" cy="-11" r="3.5" fill="{B}" stroke="{B}"/><path d="M-16 8 h32 v18 h-32 z" stroke="{W}"/></g><g transform="translate(31,8) scale(.55)"><rect x="-22" y="-26" width="44" height="30" rx="9" stroke="{W}"/><circle cx="-9" cy="-11" r="3.5" fill="{B}" stroke="{B}"/><circle cx="9" cy="-11" r="3.5" fill="{B}" stroke="{B}"/><path d="M-16 8 h32 v18 h-32 z" stroke="{W}"/></g><g transform="translate(0,-4) scale(.7)"><rect x="-22" y="-26" width="44" height="30" rx="9" stroke="{W}"/><circle cx="-9" cy="-11" r="3.5" fill="{B}" stroke="{B}"/><circle cx="9" cy="-11" r="3.5" fill="{B}" stroke="{B}"/><path d="M0 -26 V-34" stroke="{W}"/><circle cx="0" cy="-37" r="3" stroke="{B}"/><path d="M-16 8 h32 v18 h-32 z" stroke="{W}"/></g>',
    'shield': f'<path d="M0 -32 L26 -22 V0 C26 18 12 28 0 34 C-12 28 -26 18 -26 0 V-22 Z" stroke="{W}"/><path d="M-11 0 l8 8 l15 -16" stroke="{B}"/>',
    'vault': f'<rect x="-30" y="-30" width="60" height="56" rx="8" stroke="{W}"/><circle cx="0" cy="-2" r="14" stroke="{B}"/><path d="M0 -16 v-4 M0 12 v4 M-14 -2 h-4 M14 -2 h4" stroke="{B}"/><circle cx="0" cy="-2" r="3" fill="{B}" stroke="{B}"/><path d="M-22 26 v6 M22 26 v6" stroke="{W}"/>',
    'mpc': f'<circle cx="0" cy="-24" r="8" stroke="{W}"/><circle cx="-24" cy="16" r="8" stroke="{W}"/><circle cx="24" cy="16" r="8" stroke="{W}"/><path d="M-4 -17 L-20 9 M4 -17 L20 9 M-16 16 H16" stroke="{B}"/><path d="M-8 2 c4 -6 8 6 12 0 s6 -4 6 -2" stroke="{GOLD}"/>',
    'wallet': f'<rect x="-30" y="-20" width="60" height="42" rx="8" stroke="{W}"/><path d="M-24 -20 L14 -32 L18 -20" stroke="{W}"/><rect x="8" y="-6" width="22" height="14" rx="5" stroke="{B}"/><circle cx="16" cy="1" r="2.5" fill="{GOLD}" stroke="{GOLD}"/>',
    'people': f'<circle cx="0" cy="-14" r="10" stroke="{W}"/><path d="M-18 24 c0 -16 36 -16 36 0" stroke="{W}"/><circle cx="-24" cy="-6" r="7" stroke="{B}"/><path d="M-38 22 c0 -12 20 -14 24 -6" stroke="{B}"/><circle cx="24" cy="-6" r="7" stroke="{B}"/><path d="M38 22 c0 -12 -20 -14 -24 -6" stroke="{B}"/>',
    'council': f'<circle cx="0" cy="-16" r="10" stroke="{W}"/><path d="M-18 22 c0 -16 36 -16 36 0" stroke="{W}"/><path d="M18 -30 L34 -24 V-12 C34 -2 26 4 18 8 C10 4 2 -2 2 -12 V-24 Z" stroke="{B}"/>',
    'building': f'<path d="M-30 30 V-14 L0 -32 L30 -14 V30 Z" stroke="{W}"/><path d="M-18 -6 v28 M-6 -6 v28 M6 -6 v28 M18 -6 v28" stroke="{B}"/><path d="M-34 30 H34" stroke="{W}"/><circle cx="0" cy="-16" r="4" fill="{GOLD}" stroke="{GOLD}"/>',
    'directory': f'<rect x="-26" y="-30" width="52" height="60" rx="6" stroke="{W}"/><path d="M-14 -14 h28 M-14 0 h28 M-14 14 h18" stroke="{B}"/>',
    'doc': f'<path d="M-22 -32 H12 L24 -20 V32 H-22 Z" stroke="{W}"/><path d="M-12 -14 h22 M-12 -2 h22 M-12 10 h12" stroke="{B}"/>',
    'visa': f'<path d="M-22 -32 H12 L24 -20 V32 H-22 Z" stroke="{W}"/><path d="M-12 -14 h22 M-12 -2 h14" stroke="{B}"/><path d="M-12 18 c4 -8 8 6 12 -2 s6 4 10 0" stroke="{GOLD}"/>',
    'ballot': f'<rect x="-28" y="-6" width="56" height="34" rx="5" stroke="{W}"/><path d="M-12 -6 V-30 H12 V-6" stroke="{B}"/><path d="M-6 -18 l5 5 l9 -10" stroke="{B}"/>',
    'coin': f'<circle cx="0" cy="0" r="26" stroke="{GOLD}"/><path d="M8 -10 c-4 -6 -18 -4 -16 4 c2 8 16 4 16 12 c0 8 -14 8 -17 2 M0 -18 v36" stroke="{GOLD}"/>',
    'badge': f'<rect x="-22" y="-30" width="44" height="60" rx="8" stroke="{W}"/><circle cx="0" cy="-8" r="9" stroke="{B}"/><path d="M-12 14 h24" stroke="{B}"/><path d="M-8 -30 v-6 h16 v6" stroke="{W}"/>',
    'chart': f'<path d="M-28 28 H28 M-28 28 V-28" stroke="{W}"/><path d="M-20 14 L-6 0 L4 8 L22 -16" stroke="{GOLD}"/><path d="M14 -16 h8 v8" stroke="{GOLD}"/>',
    'invoice': f'<path d="M-20 -30 H20 V30 L12 24 L4 30 L-4 24 L-12 30 L-20 24 Z" stroke="{W}"/><path d="M-10 -14 h20 M-10 -2 h20" stroke="{B}"/><path d="M-10 12 h10" stroke="{GOLD}"/>',
    'swap': f'<path d="M-24 -10 H22 M12 -20 l10 10 l-10 10" stroke="{W}"/><path d="M24 14 H-22 M-12 4 l-10 10 l10 10" stroke="{B}"/>',
    'share': f'<circle cx="0" cy="-14" r="12" stroke="{GOLD}"/><path d="M0 -2 V12 M0 12 L-22 26 M0 12 L22 26 M0 12 V28" stroke="{W}"/><circle cx="-24" cy="28" r="4" stroke="{B}"/><circle cx="24" cy="28" r="4" stroke="{B}"/><circle cx="0" cy="30" r="4" stroke="{B}"/>',
}


def page(width, height, body):
    defs = (f'<defs><marker id="ah" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="{TEAL}"/></marker>'
            f'<marker id="ahs" viewBox="0 0 10 10" refX="3" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{TEAL}"/></marker></defs>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="#FFFFFF"/>{defs}{body}</svg>'


def technical():
    out.clear()
    cx = 250
    tile(cx, 90, 130, 104, 'robot', 'AI employee', 'Agent (MCP)')
    # agent <-> guard
    arrow(f'M{cx-12} 182 V262')
    arrow(f'M{cx+12} 262 V182')
    mini(cx - 52, 206, 'doc'); text(cx - 52, 246, 'Visa', 14); text(cx - 52, 263, 'request', 14)
    mini(cx + 52, 236, 'visa'); text(cx + 52, 196, 'Signed', 14); text(cx + 52, 212, 'visa', 14)
    tile(cx, 334, 130, 104, 'shield', 'Off-chain check', 'Guard (API)')
    # off/on chain line
    out.append(f'<path d="M20 452 H480" stroke="{ORANGE}" stroke-width="1.6" stroke-dasharray="8 7" opacity=".8"/>')
    text(470, 444, 'OFF CHAIN', 12, anchor='end'); text(470, 468, 'ON CHAIN', 12, anchor='end')
    # agent -> vault (left loop)
    arrow(f'M{cx-65} 90 H120 Q100 90 100 110 V530 Q100 550 120 550 H{cx-70}')
    mini(100, 452, 'doc'); text(100, 492, 'prepare', 14); text(100, 509, 'authorize', 14)
    tile(cx, 550, 130, 104, 'vault', 'NEAR contract', 'OmniRoles vault|no access key')
    # DAO -> vault
    tile(430, 550, 96, 86, 'people', 'Owners', 'Sputnik DAO')
    arrow('M382 550 H322')
    text(352, 536, 'roles', 13)
    # vault -> mpc
    arrow(f'M{cx} 662 V700')
    tile(cx, 762, 130, 104, 'mpc', 'NEAR MPC', 'Chain Signatures')
    arrow(f'M{cx} 854 V912')
    tile(cx, 972, 130, 104, 'wallet', 'Company wallet', 'Same address|on every EVM chain')
    # fan out
    ys = 1110
    xs = [130, 210, 290, 370]
    for x in xs:
        arrow(f'M{cx + (x-cx)*0.25} 1078 Q{x} 1086 {x} {ys+44}')
    for x, n in zip(xs, ['ethereum', 'base', 'arbitrum']):
        chain_tile(x, ys + 80, n)
    out.append(f'<rect x="{xs[3]-30}" y="{ys+50}" width="60" height="60" rx="12" fill="{TILE}" stroke="{ORANGE}" stroke-width="2.5"/>')
    text(xs[3], ys + 91, '+', 30, color=WHITE)
    return page(500, 1250, ''.join(out))


def product():
    out.clear()
    cx = 270
    tile(140, 80, 110, 94, 'people', 'Investors', 'buy · vote · earn')
    tile(400, 80, 110, 94, 'council', 'Founders', 'security council')
    arrow('M150 172 Q170 262 240 292')
    arrow('M390 172 Q370 262 300 292')
    mini(150, 220, 'coin'); text(108, 214, 'Buy', 14, anchor='end'); text(108, 231, 'shares', 14, anchor='end')
    mini(390, 220, 'ballot'); text(432, 214, 'Vote', 14, anchor='start'); text(432, 231, 'roles', 14, anchor='start')
    tile(cx, 352, 140, 110, 'building', 'DAO + treasury', 'AI company')
    # directory
    arrow(f'M{cx+72} 352 H420', dash='7 7')
    tile(470, 352, 90, 80, 'directory', 'Directory', 'public|on chain')
    # roles -> employees
    arrow(f'M{cx} 450 V520')
    mini(cx + 46, 484, 'badge'); text(cx + 76, 482, 'Roles', 14, anchor='start'); text(cx + 76, 499, 'and budgets', 14, anchor='start')
    tile(cx, 586, 140, 110, 'robots', 'AI employees', 'Agents over MCP')
    xs = [120, 220, 320, 420]
    for x in xs:
        arrow(f'M{cx + (x-cx)*0.25} 680 Q{x} 690 {x} 736')
    for x, ic, lab in zip(xs, ['chart', 'invoice', 'swap', 'share'], ['DeFi', 'Pay|suppliers', 'Swaps', 'Share|revenue']):
        out.append(f'<rect x="{x-32}" y="742" width="64" height="64" rx="12" fill="{TILE}" stroke="{ORANGE}" stroke-width="2.5"/>')
        out.append(f'<g transform="translate({x},774) scale(.62)" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="4">{ICONS[ic]}</g>')
        for i, line in enumerate(lab.split('|')):
            text(x, 830 + i * 18, line, 15)
    # revenue loop back to investors
    arrow('M420 870 V900 Q420 920 400 920 H60 Q40 920 40 900 V100 Q40 80 60 80 H80')
    mini(40, 520, 'coin'); text(52, 568, 'Revenue', 14, anchor='start'); text(52, 585, 'for voters', 14, anchor='start')
    return page(540, 950, ''.join(out))


if __name__ == '__main__':
    d = sys.argv[1]
    open(f'{d}/technical.svg', 'w').write(technical())
    open(f'{d}/product.svg', 'w').write(product())
    print('ok')
