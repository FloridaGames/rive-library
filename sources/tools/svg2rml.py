# -*- coding: utf-8 -*-
"""svg2rml — zet een SVG om in Rive RML (echte Rive-vectoren) voor de Rive CLI.

  python tools/svg2rml.py <bestand.svg> <uit.rml> --name Karakter --client 1 [--width 240] [--background FFFFFFFF]
  python tools/svg2rml.py <bestand.svg> --fragment [--client 1]      # alleen de <Node>-subtree naar stdout

De Rive CLI importeert zelf geen SVG (dat kan alleen de editor), dus dit script doet de omzetting:
  - path (M L H V C S Q T A Z), rect, circle, ellipse, line, polyline, polygon, g, use, linear/radialGradient
  - transforms (matrix/translate/scale/rotate/skew) worden platgeslagen naar artboard-coördinaten
  - style="…", <style>-klassen (Illustrator: .st0{fill:#…}) en geërfde fill/stroke van groepen
  - tekenvolgorde omgekeerd: SVG tekent het laatste element bovenop, Rive het eerste
  - SVG id  ->  Rive name (daar animeer je op); elk element krijgt een id <client>:<n> die uit de naam wordt
    afgeleid (crc32, vanaf 10000): de SVG bijwerken en opnieuw converteren houdt de ids gelijk zolang de namen
    gelijk blijven, dus animaties (objectId) blijven werken. Handwerk gebruikt ids onder de 10000.
  - groep  ->  Node; een kind met id "<groep>-pivot" (of data-pivot="x,y" op de groep) wordt het draaipunt
  - circle/ellipse/rect zonder rotatie/skew worden parametrische Ellipse/Rectangle (breedte/hoogte animeerbaar),
    al het andere wordt een PointsPath met Straight/CubicDetached-vertices (hoeken in radialen)
Niet ondersteund (waarschuwing, overgeslagen): text (in Illustrator: Type > Create Outlines), image, clipPath,
mask, filter. Eénmalige conversie: daarna is het RML de bron; animaties en state machine schrijf je eronder.
Alleen standaardbibliotheek, geen pip."""
import argparse, math, re, sys, zlib
import xml.etree.ElementTree as ET

SVG = '{http://www.w3.org/2000/svg}'
XLINK = '{http://www.w3.org/1999/xlink}'
INHERITED = ('fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule',
             'fill-opacity', 'stroke-opacity', 'color', 'visibility', 'display')
STYLE_KEYS = INHERITED + ('opacity', 'stop-color', 'stop-opacity')
NAMED = {'black': '000000', 'white': 'ffffff', 'red': 'ff0000', 'green': '008000', 'blue': '0000ff',
         'yellow': 'ffff00', 'orange': 'ffa500', 'purple': '800080', 'pink': 'ffc0cb', 'gray': '808080',
         'grey': '808080', 'silver': 'c0c0c0', 'lime': '00ff00', 'navy': '000080', 'teal': '008080',
         'aqua': '00ffff', 'cyan': '00ffff', 'magenta': 'ff00ff', 'fuchsia': 'ff00ff', 'maroon': '800000',
         'olive': '808000', 'brown': 'a52a2a', 'gold': 'ffd700', 'coral': 'ff7f50', 'tomato': 'ff6347',
         'salmon': 'fa8072', 'crimson': 'dc143c', 'indigo': '4b0082', 'violet': 'ee82ee', 'khaki': 'f0e68c',
         'tan': 'd2b48c', 'beige': 'f5f5dc', 'ivory': 'fffff0', 'lavender': 'e6e6fa', 'turquoise': '40e0d0',
         'skyblue': '87ceeb', 'steelblue': '4682b4', 'royalblue': '4169e1', 'dodgerblue': '1e90ff',
         'slategray': '708090', 'darkgray': 'a9a9a9', 'lightgray': 'd3d3d3', 'dimgray': '696969',
         'darkgreen': '006400', 'seagreen': '2e8b57', 'forestgreen': '228b22', 'limegreen': '32cd32',
         'darkblue': '00008b', 'darkred': '8b0000', 'orangered': 'ff4500', 'hotpink': 'ff69b4',
         'deeppink': 'ff1493', 'chocolate': 'd2691e', 'sienna': 'a0522d', 'wheat': 'f5deb3'}
NUMBER = r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?'
KAPPA = 0.5522847498   # cubic-benadering van een kwartcirkel
warnings = []


def warn(msg):
    warnings.append(msg); sys.stderr.write('svg2rml: %s\n' % msg)


# ---------- getallen en matrices -------------------------------------------------------------------------
def num(s, default=0.0):
    """getal uit een SVG-attribuut; een eenheid erachter (px, pt) wordt genegeerd"""
    if s is None: return default
    m = re.match(r'\s*(' + NUMBER + ')', str(s))
    return float(m.group(1)) if m else default


def pct(s):
    """'50%' -> 0.5, '0.5' -> 0.5"""
    s = str(s).strip()
    return num(s) / 100 if s.endswith('%') else num(s)


def fmt(v):
    s = '%.3f' % v
    s = s.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '', '-') else s


def numbers(s):
    return [float(x) for x in re.findall(NUMBER, s or '')]


IDENT = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mmul(m, n):
    """m ∘ n: eerst n toepassen, dan m (zoals een SVG transform-lijst van links naar rechts)"""
    a, b, c, d, e, f = m; a2, b2, c2, d2, e2, f2 = n
    return (a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2,
            a * e2 + c * f2 + e, b * e2 + d * f2 + f)


def mapply(m, p):
    a, b, c, d, e, f = m
    return (a * p[0] + c * p[1] + e, b * p[0] + d * p[1] + f)


def mscale(m):
    """gemiddelde schaalfactor (voor lijndiktes)"""
    a, b, c, d = m[:4]
    return math.sqrt(abs(a * d - b * c))


def parse_transform(s):
    m = IDENT
    if not s: return m
    for name, args in re.findall(r'(\w+)\s*\(([^)]*)\)', s):
        v = numbers(args)
        if name == 'matrix' and len(v) == 6: t = tuple(v)
        elif name == 'translate': t = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == 'scale': t = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == 'rotate':
            r = math.radians(v[0]); cs, sn = math.cos(r), math.sin(r)
            t = (cs, sn, -sn, cs, 0, 0)
            if len(v) > 2:   # rotate(a cx cy) = translate(cx cy) rotate(a) translate(-cx -cy)
                t = mmul(mmul((1, 0, 0, 1, v[1], v[2]), t), (1, 0, 0, 1, -v[1], -v[2]))
        elif name == 'skewX': t = (1, 0, math.tan(math.radians(v[0])), 1, 0, 0)
        elif name == 'skewY': t = (1, math.tan(math.radians(v[0])), 0, 1, 0, 0)
        else: continue
        m = mmul(m, t)
    return m


# ---------- stijlen ----------------------------------------------------------------------------------------
def parse_decl(body):
    d = {}
    for item in body.split(';'):
        if ':' in item:
            k, v = item.split(':', 1); d[k.strip().lower()] = v.strip()
    return d


def parse_css(text):
    """.st0{fill:#FFF;} en .a,.b{...} -> {klasse: {prop: val}}; elementselectors worden genegeerd"""
    classes = {}
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    for sel, body in re.findall(r'([^{}]+)\{([^{}]*)\}', text):
        decl = parse_decl(body)
        for part in sel.split(','):
            part = part.strip()
            if re.match(r'^\.[\w-]+$', part): classes.setdefault(part[1:], {}).update(decl)
    return classes


def own_style(el, classes):
    """wat dit element zelf zet: presentation attributes < class < style="…" """
    st = {}
    for k in STYLE_KEYS:
        if el.get(k) is not None: st[k] = el.get(k)
    for cls in (el.get('class') or '').split():
        st.update(classes.get(cls, {}))
    st.update(parse_decl(el.get('style') or ''))
    return st


def parse_color(s, current='000000'):
    """-> (rrggbb, alpha 0..1) | None voor none/transparent | ('url', id) voor een gradient"""
    if s is None: return None
    s = s.strip()
    if s in ('none', 'transparent', ''): return None
    m = re.match(r'url\(\s*["\']?#([^)"\'\s]+)', s)
    if m: return ('url', m.group(1))
    if s == 'currentColor': return (current, 1.0)
    if s.startswith('#'):
        h = s[1:]
        if len(h) in (3, 4): h = ''.join(ch * 2 for ch in h)
        if len(h) == 8: return (h[:6].lower(), int(h[6:], 16) / 255.0)
        if len(h) == 6: return (h.lower(), 1.0)
    m = re.match(r'rgba?\(([^)]*)\)', s)
    if m:
        parts = [p.strip() for p in m.group(1).replace('/', ',').split(',')]
        ch = [int(round(float(p[:-1]) * 2.55)) if p.endswith('%') else int(round(float(p))) for p in parts[:3]]
        a = 1.0
        if len(parts) > 3: a = float(parts[3][:-1]) / 100 if parts[3].endswith('%') else float(parts[3])
        return ('%02x%02x%02x' % tuple(max(0, min(255, c)) for c in ch), a)
    if s.lower() in NAMED: return (NAMED[s.lower()], 1.0)
    warn('onbekende kleur %r, zwart gebruikt' % s)
    return ('000000', 1.0)


def argb(rgb, alpha):
    return '%02X%s' % (max(0, min(255, int(round(alpha * 255)))), rgb.upper())


# ---------- paddata ----------------------------------------------------------------------------------------
TOKEN = re.compile(r'[MmZzLlHhVvCcSsQqTtAa]|' + NUMBER)


class Subpath(object):
    def __init__(self, start):
        self.start = start; self.segs = []; self.closed = False   # seg: ('L', p) of ('C', c1, c2, p)


def parse_path(d):
    toks = TOKEN.findall(d or '')
    subs = []; cur = None; cmd = None; i = 0
    pos = (0.0, 0.0); startp = (0.0, 0.0); lastc = None; lastq = None

    def take(n):
        nonlocal i
        vals = []
        for _ in range(n):
            if i >= len(toks): raise ValueError('paddata eindigt onverwacht')
            vals.append(float(toks[i])); i += 1
        return vals

    def take_flags():
        """de twee boogvlaggen mogen aan elkaar en aan het volgende getal vastzitten (a5 5 0 0110 10)"""
        nonlocal i
        flags = []
        while len(flags) < 2:
            t = toks[i]
            if len(t) > 1 and t[0] in '01' and t[1] not in '.eE':
                flags.append(int(t[0])); toks[i] = t[1:]
            else:
                flags.append(int(float(t))); i += 1
        return flags

    while i < len(toks):
        t = toks[i]
        if t[0].isalpha(): cmd = t; i += 1
        elif cmd is None: raise ValueError('paddata begint zonder commando')
        rel = cmd.islower(); c = cmd.upper()
        if c == 'M':
            x, y = take(2)
            pos = (pos[0] + x, pos[1] + y) if rel else (x, y)
            cur = Subpath(pos); subs.append(cur); startp = pos; lastc = lastq = None
            cmd = 'l' if rel else 'L'   # volgende coördinatenparen zijn lineto's
            continue
        if c == 'Z':
            if cur is not None: cur.closed = True
            pos = startp; lastc = lastq = None; cur = None
            if i < len(toks) and not toks[i][0].isalpha(): cmd = 'L'
            continue
        if cur is None: cur = Subpath(pos); subs.append(cur); startp = pos
        if c == 'L':
            x, y = take(2); p = (pos[0] + x, pos[1] + y) if rel else (x, y)
            cur.segs.append(('L', p)); pos = p; lastc = lastq = None
        elif c == 'H':
            x, = take(1); p = (pos[0] + x if rel else x, pos[1])
            cur.segs.append(('L', p)); pos = p; lastc = lastq = None
        elif c == 'V':
            y, = take(1); p = (pos[0], pos[1] + y if rel else y)
            cur.segs.append(('L', p)); pos = p; lastc = lastq = None
        elif c == 'C':
            v = take(6)
            if rel: v = [v[k] + pos[k % 2] for k in range(6)]
            c1, c2, p = (v[0], v[1]), (v[2], v[3]), (v[4], v[5])
            cur.segs.append(('C', c1, c2, p)); pos = p; lastc = c2; lastq = None
        elif c == 'S':
            v = take(4)
            if rel: v = [v[k] + pos[k % 2] for k in range(4)]
            c1 = (2 * pos[0] - lastc[0], 2 * pos[1] - lastc[1]) if lastc else pos
            c2, p = (v[0], v[1]), (v[2], v[3])
            cur.segs.append(('C', c1, c2, p)); pos = p; lastc = c2; lastq = None
        elif c in ('Q', 'T'):
            if c == 'Q':
                v = take(4)
                if rel: v = [v[k] + pos[k % 2] for k in range(4)]
                q, p = (v[0], v[1]), (v[2], v[3])
            else:
                v = take(2)
                if rel: v = [v[k] + pos[k] for k in range(2)]
                q = (2 * pos[0] - lastq[0], 2 * pos[1] - lastq[1]) if lastq else pos
                p = (v[0], v[1])
            c1 = (pos[0] + 2.0 / 3 * (q[0] - pos[0]), pos[1] + 2.0 / 3 * (q[1] - pos[1]))   # graadverhoging
            c2 = (p[0] + 2.0 / 3 * (q[0] - p[0]), p[1] + 2.0 / 3 * (q[1] - p[1]))
            cur.segs.append(('C', c1, c2, p)); pos = p; lastq = q; lastc = None
        elif c == 'A':
            rx, ry, rot = take(3); large, sweep = take_flags(); x, y = take(2)
            p = (pos[0] + x, pos[1] + y) if rel else (x, y)
            cur.segs.extend(arc_to_cubics(pos, rx, ry, rot, large, sweep, p))
            pos = p; lastc = lastq = None
        else:
            raise ValueError('onbekend padcommando %r' % cmd)
    return subs


def arc_to_cubics(p0, rx, ry, rot_deg, large, sweep, p1):
    """SVG-boog (eindpuntnotatie) -> cubics, per kwart een segment; algoritme uit de SVG-spec (appendix B.2)"""
    if p0 == p1: return []
    rx, ry = abs(rx), abs(ry)
    if rx == 0 or ry == 0: return [('L', p1)]
    phi = math.radians(rot_deg); cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
    x1p, y1p = cp * dx + sp * dy, -sp * dx + cp * dy
    lam = (x1p ** 2) / (rx ** 2) + (y1p ** 2) / (ry ** 2)
    if lam > 1: rx *= math.sqrt(lam); ry *= math.sqrt(lam)
    n = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2
    d = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
    k = math.sqrt(max(0.0, n / d)) if d else 0.0
    if large == sweep: k = -k
    cxp, cyp = k * rx * y1p / ry, -k * ry * x1p / rx
    cx = cp * cxp - sp * cyp + (p0[0] + p1[0]) / 2
    cy = sp * cxp + cp * cyp + (p0[1] + p1[1]) / 2

    def ang(ux, uy, vx, vy):
        return math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dth > 0: dth -= 2 * math.pi
    if sweep and dth < 0: dth += 2 * math.pi
    n_seg = max(1, int(math.ceil(abs(dth) / (math.pi / 2) - 1e-9)))
    delta = dth / n_seg; t = 4.0 / 3 * math.tan(delta / 4)

    def to_abs(q):
        return (cp * rx * q[0] - sp * ry * q[1] + cx, sp * rx * q[0] + cp * ry * q[1] + cy)
    segs = []; a1 = th1
    for _ in range(n_seg):
        a2 = a1 + delta
        e1 = (math.cos(a1), math.sin(a1)); e2 = (math.cos(a2), math.sin(a2))
        q1 = (e1[0] - t * e1[1], e1[1] + t * e1[0]); q2 = (e2[0] + t * e2[1], e2[1] - t * e2[0])
        segs.append(('C', to_abs(q1), to_abs(q2), to_abs(e2)))
        a1 = a2
    segs[-1] = ('C', segs[-1][1], segs[-1][2], p1)
    return segs


def ellipse_subpath(cx, cy, rx, ry):
    """cirkel/ellips als vier cubics, met de klok mee vanaf rechts"""
    k = KAPPA
    s = Subpath((cx + rx, cy))
    s.segs = [('C', (cx + rx, cy + k * ry), (cx + k * rx, cy + ry), (cx, cy + ry)),
              ('C', (cx - k * rx, cy + ry), (cx - rx, cy + k * ry), (cx - rx, cy)),
              ('C', (cx - rx, cy - k * ry), (cx - k * rx, cy - ry), (cx, cy - ry)),
              ('C', (cx + k * rx, cy - ry), (cx + rx, cy - k * ry), (cx + rx, cy))]
    s.closed = True
    return [s]


def rect_subpath(x, y, w, h, rx, ry):
    rx = min(rx, w / 2); ry = min(ry, h / 2)
    if rx <= 0 or ry <= 0:
        s = Subpath((x, y)); s.segs = [('L', (x + w, y)), ('L', (x + w, y + h)), ('L', (x, y + h))]; s.closed = True
        return [s]
    k = KAPPA
    s = Subpath((x + rx, y))
    s.segs = [('L', (x + w - rx, y)),
              ('C', (x + w - rx + k * rx, y), (x + w, y + ry - k * ry), (x + w, y + ry)),
              ('L', (x + w, y + h - ry)),
              ('C', (x + w, y + h - ry + k * ry), (x + w - rx + k * rx, y + h), (x + w - rx, y + h)),
              ('L', (x + rx, y + h)),
              ('C', (x + rx - k * rx, y + h), (x, y + h - ry + k * ry), (x, y + h - ry)),
              ('L', (x, y + ry)),
              ('C', (x, y + ry - k * ry), (x + rx - k * rx, y), (x + rx, y))]
    s.closed = True
    return [s]


def transform_subs(subs, m):
    """affiene transformatie op alle punten (ook controlepunten): exact voor beziers"""
    out = []
    for s in subs:
        t = Subpath(mapply(m, s.start)); t.closed = s.closed
        for seg in s.segs:
            t.segs.append(('L', mapply(m, seg[1])) if seg[0] == 'L'
                          else ('C', mapply(m, seg[1]), mapply(m, seg[2]), mapply(m, seg[3])))
        out.append(t)
    return out


def sub_points(s):
    pts = [s.start]
    for seg in s.segs: pts.extend(seg[1:])
    return pts


def bbox_of(pts):
    return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def vertices(s):
    """-> ([(punt, in-handle|None, uit-handle|None)], gesloten). Een recht segment heeft geen handles:
    Rive tekent tussen twee vertices zonder handle een rechte lijn, dus dat is exact."""
    pts = [s.start]; vin = [None]; vout = [None]
    for seg in s.segs:
        p = seg[-1]
        if seg[0] == 'L' and dist(p, pts[-1]) < 1e-6: continue          # nullengte overslaan
        if seg[0] == 'C':
            vout[-1] = seg[1]; vin.append(seg[2])
        else:
            vin.append(None)
        pts.append(p); vout.append(None)
    if s.closed and len(pts) > 1 and dist(pts[0], pts[-1]) < 1e-6:     # eindpunt = beginpunt: samenvoegen
        vin[0] = vin[-1]; pts.pop(); vin.pop(); vout.pop()
    return list(zip(pts, vin, vout)), s.closed


def handle(p, h):
    """controlepunt -> (hoek in radialen, afstand) t.o.v. de vertex; Rive: handle = p + (cos a, sin a) * d"""
    if h is None: return 0.0, 0.0
    dx, dy = h[0] - p[0], h[1] - p[1]
    d = math.hypot(dx, dy)
    return (math.atan2(dy, dx) if d > 1e-9 else 0.0), d


# ---------- de boom ----------------------------------------------------------------------------------------
class Item(object):
    """een Node (groep) of Shape, in absolute artboard-coördinaten"""
    def __init__(self, kind, name):
        self.kind = kind; self.name = name; self.children = []; self.id = None
        self.origin = (0.0, 0.0); self.opacity = 1.0; self.bbox = None; self.local_bbox = None
        self.subs = []; self.param = None     # param: ('Ellipse', w, h) | ('Rectangle', w, h, radius)
        self.fill = None; self.stroke = None; self.fillrule = 'nonZero'
        self.stroke_width = 1.0; self.cap = 'butt'; self.join = 'miter'

    def compute_bbox(self):
        if self.kind == 'shape':
            if self.param:
                w, h = self.param[1], self.param[2]; cx, cy = self.origin
                self.bbox = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
            else:
                self.bbox = bbox_of([p for s in self.subs for p in sub_points(s)])
        else:
            boxes = [b for b in (c.compute_bbox() for c in self.children) if b]
            self.bbox = (min(b[0] for b in boxes), min(b[1] for b in boxes),
                         max(b[2] for b in boxes), max(b[3] for b in boxes)) if boxes else None
        return self.bbox

    def centre(self):
        return ((self.bbox[0] + self.bbox[2]) / 2, (self.bbox[1] + self.bbox[3]) / 2)


class Converter(object):
    def __init__(self, root, client, scale):
        self.root = root; self.client = client; self.scale = scale
        self.classes = {}; self.defs = {}; self.names = set(); self.used = set(); self.table = []
        for st in root.iter(SVG + 'style'): self.classes.update(parse_css(st.text or ''))
        for el in root.iter():
            if el.get('id'): self.defs[el.get('id')] = el

    def stable_id(self, name):
        """id uit de naam: gelijk bij elke conversie zolang de naam gelijk blijft; bij een botsing de volgende vrije"""
        n = 10000 + zlib.crc32(name.encode('utf-8')) % 90000
        while n in self.used: n += 1
        self.used.add(n); return '%d:%d' % (self.client, n)

    def unique(self, base):
        base = re.sub(r'[^\w.-]+', '-', base).strip('-') or 'element'
        name, n = base, 2
        while name in self.names: name = '%s-%d' % (base, n); n += 1
        self.names.add(name); return name

    # -- stijl ---------------------------------------------------------------------------------------------
    def style(self, el, inherited):
        st = dict((k, v) for k, v in inherited.items() if k in INHERITED)
        for k, v in own_style(el, self.classes).items():
            if v != 'inherit': st[k] = v
        return st

    def paint(self, st, key, m, item):
        """fill/stroke -> ('solid', AARRGGBB) | ('linear'|'radial', [p1, p2], stops) | None"""
        current = parse_color(st.get('color')) if st.get('color') else None
        col = parse_color(st.get(key, 'black' if key == 'fill' else 'none'), current[0] if current else '000000')
        if col is None: return None
        op = num(st.get(key + '-opacity'), 1.0)
        if col[0] == 'url':
            g = self.defs.get(col[1])
            if g is None or g.tag not in (SVG + 'linearGradient', SVG + 'radialGradient'):
                soort = 'afbeelding/patroon' if g is not None and g.tag == SVG + 'pattern' else 'geen gradient'
                warn('%s verwijst naar #%s (%s): grijs vlak gebruikt; afbeeldingen gaan in Rive via een ImageAsset' % (key, col[1], soort))
                return ('solid', argb('888888', op))
            return self.gradient(g, m, item, op)
        return ('solid', argb(col[0], col[1] * op))

    def gradient(self, g, m, item, op):
        chain = [g]; seen = {g}                        # attributen en stops mogen via href geërfd zijn
        while True:
            href = (chain[-1].get(XLINK + 'href') or chain[-1].get('href') or '').lstrip('#')
            nxt = self.defs.get(href)
            if nxt is None or nxt in seen: break
            chain.append(nxt); seen.add(nxt)

        def attr(k, default=None):
            for e in chain:
                if e.get(k) is not None: return e.get(k)
            return default
        stops_el = next((e.findall(SVG + 'stop') for e in chain if e.findall(SVG + 'stop')), [])
        stops = []
        for s in stops_el:
            ss = own_style(s, self.classes)
            col = parse_color(ss.get('stop-color', 'black')) or ('000000', 0.0)
            stops.append((max(0.0, min(1.0, pct(ss.get('offset', s.get('offset', '0'))))),
                          argb(col[0], col[1] * num(ss.get('stop-opacity'), 1.0) * op)))
        if not stops: return ('solid', argb('888888', op))
        obb = attr('gradientUnits', 'objectBoundingBox') == 'objectBoundingBox'
        gt = parse_transform(attr('gradientTransform'))
        if obb:   # 0..1 -> lokale bbox van de vorm (vóór de element-transform), dan gradientTransform, dan de CTM
            bx0, by0, bx1, by1 = item.local_bbox
            full = mmul(m, mmul((bx1 - bx0, 0, 0, by1 - by0, bx0, by0), gt))
        else:
            full = mmul(m, gt)
        conv = pct if obb else num
        if g.tag == SVG + 'linearGradient':
            p1 = (conv(attr('x1', '0')), conv(attr('y1', '0'))); p2 = (conv(attr('x2', '1' if obb else '0')), conv(attr('y2', '0')))
            return ('linear', [mapply(full, p1), mapply(full, p2)], stops)
        c = (conv(attr('cx', '0.5' if obb else '0')), conv(attr('cy', '0.5' if obb else '0'))); r = conv(attr('r', '0.5' if obb else '0'))
        return ('radial', [mapply(full, c), mapply(full, (c[0] + r, c[1]))], stops)

    # -- elementen -----------------------------------------------------------------------------------------
    def convert(self):
        root_m = (self.scale, 0, 0, self.scale, 0, 0)
        vb = self.root.get('viewBox')
        if vb:
            x0, y0 = numbers(vb)[:2]
            root_m = mmul(root_m, (1, 0, 0, 1, -x0, -y0))
        top = Item('node', 'tekening')
        self.children_of(self.root, root_m, self.style(self.root, {}), top)   # Figma zet fill="none" op de root: erft door
        return top

    def children_of(self, parent, m, st, into):
        for el in list(parent):
            it = self.element(el, m, st)
            if it is not None: into.children.append(it)

    def element(self, el, m, st, name_override=None):
        if not isinstance(el.tag, str) or not el.tag.startswith(SVG): return None   # commentaar, vreemde namespace
        tag = el.tag[len(SVG):]
        if tag in ('defs', 'style', 'title', 'desc', 'metadata', 'linearGradient', 'radialGradient', 'symbol',
                   'pattern', 'marker', 'clipPath', 'mask', 'filter'):
            return None
        st = self.style(el, st)
        if st.get('display') == 'none' or st.get('visibility') == 'hidden': return None
        for k in ('clip-path', 'mask', 'filter'):   # Figma: frames clippen, afbeeldingen maskeren, effecten (schaduw, blur)
            if el.get(k) or k in parse_decl(el.get('style') or ''):
                warn('%s op <%s%s> wordt genegeerd (Rive kent alleen ClippingShape en Feather); getekend zonder' % (k, tag, ' id="%s"' % el.get('id') if el.get('id') else ''))
        m = mmul(m, parse_transform(el.get('transform')))
        if tag in ('g', 'svg', 'a', 'switch'):
            return self.group(el, tag, m, st, name_override)
        if tag == 'use':
            href = (el.get(XLINK + 'href') or el.get('href') or '').lstrip('#')
            ref = self.defs.get(href)
            if ref is None: warn('<use> verwijst naar onbekend #%s' % href); return None
            m2 = mmul(m, (1, 0, 0, 1, num(el.get('x')), num(el.get('y'))))
            if ref.tag == SVG + 'symbol': return self.group(ref, 'symbol', m2, st, el.get('id') or href)
            return self.element(ref, m2, st, name_override=el.get('id') or href)
        if tag in ('text', 'image', 'foreignObject'):
            warn('<%s%s> overgeslagen (%s)' % (tag, ' id="%s"' % el.get('id') if el.get('id') else '',
                 'tekst eerst omzetten naar outlines' if tag == 'text' else 'niet ondersteund'))
            return None
        return self.shape(el, tag, m, st, name_override)

    def group(self, el, tag, m, st, name_override):
        it = Item('node', self.unique(name_override or el.get('id') or 'groep'))
        own = own_style(el, self.classes)
        it.opacity = num(own.get('opacity'), 1.0) if 'opacity' in own else 1.0
        pivot = None
        for child in list(el):
            cid = child.get('id') or ''
            if cid == 'pivot' or cid.endswith('-pivot') or cid.endswith('_pivot'):   # hulpvorm: draaipunt, niet tekenen
                pv = self.element(child, m, st)
                if pv is not None and pv.bbox: pivot = pv.centre()
                continue
            c = self.element(child, m, st)
            if c is not None: it.children.append(c)
        if el.get('data-pivot'):
            px, py = numbers(el.get('data-pivot'))[:2]
            pivot = mapply(m, (px, py))
        if not it.children: return None
        it.compute_bbox()
        it.origin = pivot or it.centre()
        return it

    def shape(self, el, tag, m, st, name_override):
        it = Item('shape', self.unique(name_override or el.get('id') or tag))
        own = own_style(el, self.classes)
        it.opacity = num(own.get('opacity'), 1.0) if 'opacity' in own else 1.0
        simple = abs(m[1]) < 1e-9 and abs(m[2]) < 1e-9 and m[0] > 0 and m[3] > 0   # alleen verschuiven/schalen
        subs = None
        if tag == 'path':
            try: subs = parse_path(el.get('d'))
            except (ValueError, IndexError) as e: warn('path %s: %s' % (it.name, e)); return None
        elif tag in ('circle', 'ellipse'):
            cx, cy = num(el.get('cx')), num(el.get('cy'))
            rx = num(el.get('r')) if tag == 'circle' else num(el.get('rx')); ry = rx if tag == 'circle' else num(el.get('ry'))
            if rx <= 0 or ry <= 0: return None
            it.local_bbox = (cx - rx, cy - ry, cx + rx, cy + ry)
            if simple:
                it.param = ('Ellipse', 2 * rx * m[0], 2 * ry * m[3]); it.origin = mapply(m, (cx, cy))
            subs = ellipse_subpath(cx, cy, rx, ry)
        elif tag == 'rect':
            x, y, w, h = num(el.get('x')), num(el.get('y')), num(el.get('width')), num(el.get('height'))
            rx = num(el.get('rx'), -1); ry = num(el.get('ry'), -1)
            if rx < 0 and ry < 0: rx = ry = 0
            elif rx < 0: rx = ry
            elif ry < 0: ry = rx
            if w <= 0 or h <= 0: return None
            it.local_bbox = (x, y, x + w, y + h)
            if simple and abs(rx * m[0] - ry * m[3]) < 1e-6:
                it.param = ('Rectangle', w * m[0], h * m[3], min(rx * m[0], w * m[0] / 2)); it.origin = mapply(m, (x + w / 2, y + h / 2))
            subs = rect_subpath(x, y, w, h, rx, ry)
        elif tag == 'line':
            s = Subpath((num(el.get('x1')), num(el.get('y1')))); s.segs = [('L', (num(el.get('x2')), num(el.get('y2'))))]
            subs = [s]
        elif tag in ('polyline', 'polygon'):
            v = numbers(el.get('points')); pts = list(zip(v[0::2], v[1::2]))
            if len(pts) < 2: return None
            s = Subpath(pts[0]); s.segs = [('L', p) for p in pts[1:]]; s.closed = tag == 'polygon'
            subs = [s]
        else:
            warn('<%s> overgeslagen (niet ondersteund)' % tag); return None
        if not subs: return None
        if it.param is None:
            it.local_bbox = bbox_of([p for s in subs for p in sub_points(s)])
            it.subs = transform_subs(subs, m)
            it.compute_bbox(); it.origin = it.centre()
        else:
            it.compute_bbox()
        it.fill = self.paint(st, 'fill', m, it)
        it.stroke = self.paint(st, 'stroke', m, it)
        it.fillrule = 'evenOdd' if st.get('fill-rule') == 'evenodd' else 'nonZero'
        it.stroke_width = num(st.get('stroke-width'), 1.0) * mscale(m)
        it.cap = {'round': 'round', 'square': 'square'}.get(st.get('stroke-linecap'), 'butt')
        it.join = {'round': 'round', 'bevel': 'bevel'}.get(st.get('stroke-linejoin'), 'miter')
        if it.fill is None and (it.stroke is None or it.stroke_width <= 0): return None
        return it

    # -- uitvoer -------------------------------------------------------------------------------------------
    def emit(self, it, parent_origin, indent, out):
        pad = '    ' * indent
        lx, ly = it.origin[0] - parent_origin[0], it.origin[1] - parent_origin[1]
        it.id = self.stable_id(it.name); self.table.append((it.name, it.id, it.kind))
        op = '' if abs(it.opacity - 1) < 1e-6 else ' opacity="%s"' % fmt(it.opacity)
        if it.kind == 'node':
            out.append('%s<Node x="%s" y="%s"%s name="%s" id="%s">' % (pad, fmt(lx), fmt(ly), op, it.name, it.id))
            for c in reversed(it.children): self.emit(c, it.origin, indent + 1, out)   # SVG: laatste bovenop; Rive: eerste bovenop
            out.append('%s</Node>' % pad)
            return
        out.append('%s<Shape x="%s" y="%s"%s name="%s" id="%s">' % (pad, fmt(lx), fmt(ly), op, it.name, it.id))
        if it.param and it.param[0] == 'Ellipse':
            out.append('%s    <Ellipse width="%s" height="%s" originX="0.5" originY="0.5" name="Path"/>' % (pad, fmt(it.param[1]), fmt(it.param[2])))
        elif it.param:
            r = ' cornerRadiusTL="%s"' % fmt(it.param[3]) if it.param[3] > 0 else ''
            out.append('%s    <Rectangle width="%s" height="%s"%s originX="0.5" originY="0.5" name="Path"/>' % (pad, fmt(it.param[1]), fmt(it.param[2]), r))
        else:
            for k, s in enumerate(it.subs):
                vs, closed = vertices(s)
                if len(vs) < 2: continue
                out.append('%s    <PointsPath%s name="Pad%s">' % (pad, ' isClosed="true"' if closed else '', k + 1 if len(it.subs) > 1 else ''))
                for p, vin, vout in vs:
                    x, y = p[0] - it.origin[0], p[1] - it.origin[1]
                    if vin is None and vout is None:
                        out.append('%s        <StraightVertex x="%s" y="%s"/>' % (pad, fmt(x), fmt(y)))
                    else:
                        ir, idist = handle(p, vin); orot, od = handle(p, vout)
                        out.append('%s        <CubicDetachedVertex x="%s" y="%s" inRotation="%s" inDistance="%s" outRotation="%s" outDistance="%s"/>'
                                   % (pad, fmt(x), fmt(y), fmt(ir), fmt(idist), fmt(orot), fmt(od)))
                out.append('%s    </PointsPath>' % pad)
        if it.fill:
            fr = ' fillRule="evenOdd"' if it.fillrule == 'evenOdd' else ''
            out.append('%s    <Fill%s name="Fill">' % (pad, fr)); self.emit_paint(it, it.fill, indent + 2, out); out.append('%s    </Fill>' % pad)
        if it.stroke and it.stroke_width > 0:
            cap = '' if it.cap == 'butt' else ' cap="%s"' % it.cap; join = '' if it.join == 'miter' else ' join="%s"' % it.join
            out.append('%s    <Stroke thickness="%s"%s%s name="Stroke">' % (pad, fmt(it.stroke_width), cap, join))
            self.emit_paint(it, it.stroke, indent + 2, out); out.append('%s    </Stroke>' % pad)
        out.append('%s</Shape>' % pad)

    def emit_paint(self, it, paint, indent, out):
        pad = '    ' * indent
        if paint[0] == 'solid':
            out.append('%s<SolidColor colorValue="%s" name="Kleur"/>' % (pad, paint[1])); return
        (p1, p2), stops = paint[1], paint[2]
        ox, oy = it.origin
        tagname = 'LinearGradient' if paint[0] == 'linear' else 'RadialGradient'
        out.append('%s<%s startX="%s" startY="%s" endX="%s" endY="%s" name="Verloop">'
                   % (pad, tagname, fmt(p1[0] - ox), fmt(p1[1] - oy), fmt(p2[0] - ox), fmt(p2[1] - oy)))
        for pos, col in stops: out.append('%s    <GradientStop colorValue="%s" position="%s"/>' % (pad, col, fmt(pos)))
        out.append('%s</%s>' % (pad, tagname))


def main():
    ap = argparse.ArgumentParser(description='SVG -> Rive RML voor de Rive CLI')
    ap.add_argument('svg'); ap.add_argument('out', nargs='?')
    ap.add_argument('--name', help='artboardnaam (standaard: bestandsnaam)')
    ap.add_argument('--client', type=int, default=1, help='id-prefix <client>:<n>; per .rml-bestand uniek houden')
    ap.add_argument('--width', type=float, help='artboardbreedte; schaalt de tekening uniform')
    ap.add_argument('--background', help='achtergrondkleur AARRGGBB (standaard transparant)')
    ap.add_argument('--fragment', action='store_true', help='alleen de <Node>-subtree naar stdout (om in een artboard te plakken)')
    a = ap.parse_args()

    root = ET.parse(a.svg).getroot()
    if root.tag != SVG + 'svg': sys.exit('geen SVG-root (mist xmlns="http://www.w3.org/2000/svg"?)')
    vb = root.get('viewBox')
    if vb: vw, vh = numbers(vb)[2:4]
    else: vw, vh = num(root.get('width'), 100), num(root.get('height'), 100)
    scale = a.width / vw if a.width else 1.0
    aw, ah = vw * scale, vh * scale

    conv = Converter(root, a.client, scale)
    top = conv.convert()
    if not top.children: sys.exit('niets te tekenen gevonden')
    name = a.name or re.sub(r'\.svg$', '', a.svg.replace('\\', '/').split('/')[-1])
    top.name = conv.unique(name.lower())
    top.compute_bbox()

    if a.fragment:
        lines = []; conv.emit(top, (0, 0), 2, lines)
        sys.stdout.write('\n'.join(lines) + '\n')
        return
    c = a.client; body = []
    conv.emit(top, (0, 0), 2, body)
    lines = ['<!-- %s: gegenereerd door tools/svg2rml.py uit %s (%s x %s). De tekening staat in <Node name="%s">;\n'
             '     animaties, state machine en view model zijn handwerk en staan eronder. De namen komen uit de SVG-ids. -->'
             % (name, a.svg.replace('\\', '/'), fmt(aw), fmt(ah), top.name),
             '<Rive version="1" kind="fragment">',
             '    <Artboard defaultStateMachineId="%d:3" styleId="%d:5" width="%s" height="%s" name="%s" id="%d:2">' % (c, c, fmt(aw), fmt(ah), name, c),
             '        <LayoutComponentStyle name="Artboard Style" id="%d:5"/>' % c]
    if a.background:
        lines.append('        <Fill name="Achtergrond"><SolidColor colorValue="%s" name="Kleur"/></Fill>' % a.background.upper())
    lines.extend(body)
    lines.extend(['',
                  '        <StateMachine name="%s" id="%d:3">' % (name, c),
                  '            <StateMachineLayer name="Laag 1" id="%d:4">' % c,
                  '                <AnyState x="200" y="-120"/>',
                  '                <ExitState x="400" y="-120"/>',
                  '                <EntryState/>',
                  '            </StateMachineLayer>',
                  '        </StateMachine>',
                  '    </Artboard>',
                  '</Rive>'])
    text = '\n'.join(lines) + '\n'
    if a.out:
        with open(a.out, 'w', encoding='utf-8', newline='\n') as f: f.write(text)
    else:
        sys.stdout.write(text)
    # naam -> id, zodat je meteen KeyedObject objectId="…" kunt schrijven
    sys.stdout.write('\n%s  %s x %s  (%d elementen%s)\n' % (name, fmt(aw), fmt(ah), len(conv.table), '' if a.out is None else ' -> ' + a.out))
    w = max(len(n) for n, _, _ in conv.table)
    for n, i, k in conv.table: sys.stdout.write('  %-*s  %-8s %s\n' % (w, n, i, k))
    if warnings: sys.stdout.write('%d waarschuwing(en), zie stderr\n' % len(warnings))


if __name__ == '__main__':
    main()
