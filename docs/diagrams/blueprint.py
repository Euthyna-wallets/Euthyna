"""Euthyna architecture diagrams, blueprint style (site palette)."""
import sys, re, pathlib

CHAINS = pathlib.Path(__file__).resolve().parents[2] / 'apps/console/public/chains'
if not CHAINS.exists():
    CHAINS = pathlib.Path('/home/claude/mandateos/apps/console/public/chains')

BG = '#0F2A5C'
GRID = '#1B3A72'
NODE = '#16376F'
CYAN = '#4FD1E8'
GOLD = '#F2B544'
WHITE = '#F2F6FC'
MUTED = '#9FB3D9'
FONT = "'IBM Plex Mono', monospace"

out = []


def text(x, y, s, size=14, color=WHITE, anchor='middle', weight=400):
    out.append(f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" fill="{color}" text-anchor="{anchor}" font-weight="{weight}">{s}</text>')


def node(cx, cy, r, icon, title, sub=None, ring=CYAN):
    out.append(f'<circle cx="{cx}" cy="{cy}" r="{r+7}" fill="none" stroke="{ring}" stroke-width="1.2" stroke-dasharray="3 5" opacity=".7"/>')
    out.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{NODE}" stroke="{ring}" stroke-width="2.2"/>')
    out.append(f'<g transform="translate({cx},{cy}) scale({r/52})" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="3.4">{ICONS[icon]}</g>')
    y = cy + r + 30
    text(cx, y, title, 16, WHITE, weight=700)
    if sub:
        for i, line in enumerate(sub.split('|')):
            text(cx, y + 20 + i * 18, line, 13, MUTED)


def chip(x, y, label, color=CYAN, anchor='middle'):
    """Pill label sitting on an arrow."""
    w = 8.4 * len(label) + 22
    x0 = x - w / 2 if anchor == 'middle' else (x if anchor == 'start' else x - w)
    out.append(f'<rect x="{x0}" y="{y-14}" width="{w}" height="26" rx="13" fill="{BG}" stroke="{color}" stroke-width="1.6"/>')
    text(x0 + w / 2, y + 4, label, 13, color, weight=600)


def arrow(d, color=CYAN, dash=None, w=2.6):
    da = f' stroke-dasharray="{dash}"' if dash else ''
    mid = 'ag' if color == GOLD else 'ac'
    out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linecap="round"{da} marker-end="url(#{mid})"/>')


def chain_logo(cx, cy, name, size=28):
    if name == 'ethereum':
        out.append(f'<g transform="translate({cx},{cy}) scale({size/30})"><path d="M0 -15 L-9 0 L0 5 L9 0 Z" fill="#C9D6EE"/><path d="M0 7 L-9 2 L0 15 L9 2 Z" fill="#9FB3D9"/><path d="M0 -15 L0 5 L9 0 Z" fill="#E6ECF8"/></g>')
        return
    svg = (CHAINS / f'{name}.svg').read_text()
    vb = re.search(r'viewBox="([^"]+)"', svg).group(1).split()
    inner = re.sub(r'^.*?<svg[^>]*>|</svg>\s*$', '', svg, flags=re.S)
    vw, vh = float(vb[2]), float(vb[3])
    k = size / max(vw, vh)
    out.append(f'<g transform="translate({cx - vw*k/2},{cy - vh*k/2}) scale({k}) translate({-float(vb[0])},{-float(vb[1])})">{inner}</g>')


def chain_hex(cx, cy, name=None, label=None):
    pts = ' '.join(f'{cx + 32*c},{cy + 32*s}' for c, s in [(0, -1), (.866, -.5), (.866, .5), (0, 1), (-.866, .5), (-.866, -.5)])
    out.append(f'<polygon points="{pts}" fill="{NODE}" stroke="{GOLD}" stroke-width="2"/>')
    if name:
        chain_logo(cx, cy, name)
    if label:
        text(cx, cy + 8, label, 22, WHITE, weight=700)


def job(cx, cy, icon, label):
    pts = ' '.join(f'{cx + 34*c},{cy + 34*s}' for c, s in [(0, -1), (.866, -.5), (.866, .5), (0, 1), (-.866, .5), (-.866, -.5)])
    out.append(f'<polygon points="{pts}" fill="{NODE}" stroke="{GOLD}" stroke-width="2"/>')
    out.append(f'<g transform="translate({cx},{cy}) scale(.5)" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.5">{ICONS[icon]}</g>')
    for i, line in enumerate(label.split('|')):
        text(cx, cy + 58 + i * 17, line, 13, WHITE, weight=600)


W, C, G = WHITE, CYAN, GOLD
ICONS = {
    # agent: chip-shaped head with a single visor and a status light
    'agent': f'<path d="M-22 -20 h44 v30 h-44 z" stroke="{W}"/><path d="M-14 -8 h28" stroke="{C}" stroke-width="6"/><path d="M-30 -10 h8 M22 -10 h8 M-30 0 h8 M22 0 h8" stroke="{W}"/><path d="M-10 10 v10 M10 10 v10 M-18 24 h36" stroke="{W}"/><circle cx="16" cy="-28" r="3.5" fill="{G}" stroke="{G}"/>',
    'agents': ''.join(f'<g transform="translate({dx},{dy}) scale({s})"><path d="M-22 -20 h44 v30 h-44 z" stroke="{W}"/><path d="M-14 -8 h28" stroke="{C}" stroke-width="6"/><path d="M-10 10 v10 M10 10 v10 M-18 24 h36" stroke="{W}"/></g>' for dx, dy, s in [(-26, 8, .55), (26, 8, .55), (0, -8, .75)]),
    'guard': f'<path d="M-24 -24 h48 v22 c0 18 -14 28 -24 32 c-10 -4 -24 -14 -24 -32 z" stroke="{W}"/><path d="M-12 -6 h24 M-12 4 h16" stroke="{C}"/><circle cx="12" cy="16" r="5" stroke="{G}"/>',
    'vault': f'<path d="M-28 -26 h56 v52 h-56 z" stroke="{W}"/><path d="M-18 -14 h36 M-18 -2 h24 M-18 10 h30" stroke="{C}"/><path d="M14 -32 l8 8" stroke="{G}"/><circle cx="24" cy="18" r="9" fill="{NODE}" stroke="{G}"/><path d="M21 18 l3 3 l5 -6" stroke="{G}"/>',
    'mpc': ''.join(f'<path d="M0 0 L{x} {y}" stroke="{C}"/><circle cx="{x}" cy="{y}" r="6" fill="{NODE}" stroke="{W}"/>' for x, y in [(0, -28), (26, -10), (18, 24), (-18, 24), (-26, -10)]) + f'<circle cx="0" cy="0" r="9" fill="{NODE}" stroke="{G}"/>',
    'wallet': f'<path d="M-28 -18 h50 a6 6 0 0 1 6 6 v34 h-56 z" stroke="{W}"/><path d="M8 -2 h20 v14 h-20 z" stroke="{C}"/><circle cx="-12" cy="4" r="8" stroke="{G}"/><path d="M-12 0 v8" stroke="{G}"/>',
    'dao': f'<path d="M-30 -8 h60" stroke="{W}"/><path d="M-24 -8 v30 M-8 -8 v30 M8 -8 v30 M24 -8 v30" stroke="{C}"/><path d="M-30 22 h60" stroke="{W}"/><path d="M-30 -8 L0 -28 L30 -8" stroke="{W}"/>',
    'investors': f'<path d="M-20 22 v-14 a10 10 0 0 1 20 0 v14" stroke="{W}"/><circle cx="-10" cy="-12" r="8" stroke="{W}"/><circle cx="18" cy="-2" r="12" stroke="{G}"/><path d="M18 -8 v12 M14 -5 h7 a3 3 0 0 1 0 6 h-6 a3 3 0 0 0 0 6 h8" stroke="{G}" stroke-width="2.6"/>',
    'founders': f'<path d="M-22 22 v-14 a10 10 0 0 1 20 0 v14" stroke="{W}"/><circle cx="-12" cy="-12" r="8" stroke="{W}"/><path d="M8 -24 l18 6 v12 c0 12 -9 18 -18 22 c-9 -4 -18 -10 -18 -22 v-12 z" stroke="{C}" transform="translate(8,4) scale(.85)"/>',
    'company': f'<path d="M-26 28 v-44 h24 v44 M-2 28 v-30 h28 v30" stroke="{W}"/><path d="M-18 -8 h8 M-18 4 h8 M-18 16 h8 M6 6 h12 M6 16 h12" stroke="{C}"/><path d="M-32 28 h64" stroke="{W}"/><circle cx="12" cy="-16" r="6" stroke="{G}"/>',
    'directory': f'<path d="M-22 -26 h44 v52 h-44 z" stroke="{W}"/><circle cx="-10" cy="-12" r="3" fill="{C}" stroke="{C}"/><circle cx="-10" cy="2" r="3" fill="{C}" stroke="{C}"/><circle cx="-10" cy="16" r="3" fill="{C}" stroke="{C}"/><path d="M-2 -12 h16 M-2 2 h16 M-2 16 h10" stroke="{W}"/>',
    'chart': f'<path d="M-26 24 h52" stroke="{W}"/><path d="M-18 24 v-14 M-4 24 v-24 M10 24 v-18 M24 24 v-36" stroke="{G}" stroke-width="7"/>',
    'invoice': f'<path d="M-20 -28 h40 v56 h-40 z" stroke="{W}"/><path d="M-10 -14 h20 M-10 -2 h20" stroke="{C}"/><path d="M0 8 v14 M-5 12 h8 a3 3 0 0 1 0 6 h-6" stroke="{G}"/>',
    'swap': f'<circle cx="-12" cy="-6" r="13" stroke="{W}"/><circle cx="12" cy="6" r="13" stroke="{G}"/><path d="M-26 22 a26 26 0 0 0 20 6" stroke="{C}"/><path d="M26 -22 a26 26 0 0 0 -20 -6" stroke="{C}"/>',
    'share': f'<circle cx="0" cy="0" r="22" stroke="{W}"/><path d="M0 0 V-22 M0 0 L19 11 M0 0 L-19 11" stroke="{G}"/>',
}


def page(width, height):
    grid = ''.join(f'<path d="M{x} 0 V{height}" stroke="{GRID}" stroke-width="1"/>' for x in range(0, width, 32)) + \
           ''.join(f'<path d="M0 {y} H{width}" stroke="{GRID}" stroke-width="1"/>' for y in range(0, height, 32))
    defs = ''.join(f'<marker id="{i}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 1 L9 5 L0 9" fill="none" stroke="{c}" stroke-width="2"/></marker>' for i, c in [('ac', CYAN), ('ag', GOLD)])
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><rect width="100%" height="100%" fill="{BG}"/>{grid}<defs>{defs}</defs>{"".join(out)}</svg>'


def legend(y, w):
    out.append(f'<path d="M24 {y} h28" stroke="{CYAN}" stroke-width="2.6"/>'); text(60, y + 4, 'control', 12, MUTED, 'start')
    out.append(f'<path d="M150 {y} h28" stroke="{GOLD}" stroke-width="2.6"/>'); text(186, y + 4, 'money', 12, MUTED, 'start')


def technical():
    out.clear()
    cx = 290
    text(24, 40, 'EUTHYNA · TECHNICAL', 13, GOLD, 'start', 700)
    legend(64, 600)
    # Off chain: the agent, and an optional advisory Guard.
    node(cx, 160, 46, 'agent', 'AI employee', 'agent over MCP|key in euthyna-signer')
    out.append(f'<g opacity=".75">')
    node(500, 160, 34, 'guard', 'Guard', 'optional|invoice advice')
    out.append('</g>')
    arrow(f'M456 160 H{cx+58}', dash='5 6', w=2)
    out.append(f'<path d="M16 330 H584" stroke="{MUTED}" stroke-width="1.4" stroke-dasharray="2 6"/>')
    text(570, 322, 'off chain', 12, MUTED, 'end'); text(570, 348, 'on chain', 12, MUTED, 'end')
    # Agent acts directly on the vault: no visa, no backend.
    arrow(f'M{cx-54} 160 H112 V470 H{cx-62}')
    chip(112, 330, 'prepare · authorize')
    node(cx, 470, 52, 'vault', 'OmniRoles vault', 'roles · budgets · suppliers|no access key · holds the NEAR', ring=GOLD)
    node(500, 470, 40, 'dao', 'Owners', 'Sputnik DAO|vote + veto')
    arrow(f'M453 470 H{cx+66}')
    text(398, 458, 'vote rules', 12, CYAN, weight=600)
    # Vault asks MPC to sign; MPC sends back verified receipts.
    arrow(f'M{cx-16} 604 V666')
    arrow(f'M{cx+16} 666 V604')
    chip(cx - 64, 635, 'sign')
    chip(cx + 84, 635, 'verified receipt')
    node(cx, 726, 46, 'mpc', 'NEAR MPC', 'signs · verifies receipts')
    arrow(f'M{cx} 828 V884')
    node(cx, 940, 46, 'wallet', 'Company wallets', 'MPC-derived · no key|gas paid by Euthyna', ring=GOLD)
    chip(cx, 1096, 'signed tx · relayed as is', GOLD)
    xs = [70, 158, 246, 334, 422, 510]
    live = ('base', 'solana')
    for x, n in zip(xs, ['base', 'solana', 'ethereum', 'arbitrum', 'bitcoin', None]):
        arrow(f'M{cx + (x-cx)*0.12} 1112 Q{x} 1118 {x} 1158', color=GOLD, dash=None if n in live else '5 6')
    for x, n in zip(xs, ['base', 'solana', 'ethereum', 'arbitrum', 'bitcoin', None]):
        dim = n not in live
        if dim:
            out.append('<g opacity=".55">')
        chain_hex(x, 1198, n, None if n else '+')
        if dim:
            out.append('</g>')
    text(114, 1262, 'live (testnet, devnet)', 12, GOLD)
    text(290, 1262, 'mapped', 12, MUTED)
    text(466, 1262, 'next', 12, MUTED)
    # MPC reads the finalized receipt on the destination chain.
    arrow(f'M560 1166 V726 H{cx+58}', dash='7 6', w=2.2)
    chip(580, 1000, 'finalized receipt', anchor='end')
    return page(600, 1290)


def product():
    out.clear()
    cx = 290
    text(24, 40, 'EUTHYNA · PRODUCT', 13, GOLD, 'start', 700)
    legend(64, 580)
    node(100, 160, 40, 'investors', 'Shareholders', 'buy · lock|vote calls · earn')
    node(cx, 160, 40, 'dao', 'Founders', 'vote roles|budgets · members')
    node(480, 160, 40, 'founders', 'Security council', 'veto · halt|founders by default')
    arrow('M84 290 Q84 372 226 400', color=GOLD)
    arrow('M122 290 Q150 342 240 376')
    arrow(f'M{cx} 290 V362')
    arrow('M478 290 Q470 342 342 376')
    chip(92, 350, 'buy shares', GOLD)
    chip(cx, 326, 'vote roles')
    chip(468, 334, 'veto · halt')
    node(cx, 430, 52, 'company', 'Company', 'DAO + keyless vault|NEAR · Base · Solana · IBAN', ring=GOLD)
    arrow(f'M{cx+62} 430 H456', dash='6 6')
    node(510, 430, 34, 'directory', 'Directory', 'public|on chain')
    arrow(f'M{cx} 556 V610')
    chip(cx, 583, 'roles and budgets')
    node(cx, 666, 48, 'agents', 'Agents and people', 'act within their role')
    xs = [140, 240, 340, 440]
    for x in xs:
        arrow(f'M{cx + (x-cx)*0.2} 770 Q{x} 778 {x} 818', color=GOLD)
    for x, ic, lab in zip(xs, ['invoice', 'swap', 'directory', 'share'], ['Pay|suppliers', 'Swap|sealed', 'Market|sell, hire', 'Revenue|home']):
        job(x, 856, ic, lab)
    arrow('M440 950 V986 H22 V160 H56', color=GOLD)
    chip(240, 986, 'revenue for voters', GOLD)
    return page(580, 1020)


if __name__ == '__main__':
    d = sys.argv[1]
    open(f'{d}/technical.svg', 'w').write(technical())
    open(f'{d}/product.svg', 'w').write(product())
    print('ok')
