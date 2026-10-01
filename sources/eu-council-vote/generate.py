# -*- coding: utf-8 -*-
"""EU Council vote: the round table of the Council of the EU, 27 member states, each one lit up by code.

  python sources/eu-council-vote/generate.py           # eu-court.svg -> rive/council-vote.rml
  python sources/eu-council-vote/generate.py --build   # ... and builds samples/eu-council-vote/eu-council-vote.riv

The drawing is eu-court.svg (from Illustrator, EU-court_27_leden.ai): real vectors, grouped per country in four
layers: Midden (the EU flag and the wreath), Stoelen, Tafel per land (per country: tafeldeel, tafelitems, vlag) and
Personen. This script

  1. cleans the SVG: plain ids per country (`vlag-BE`, `figuur-BE`, `tafelrand-BE`, ...) and the flags moved out of
     their table group into a layer of their own above the table, so an enlarged flag is never hidden under a
     neighbour's papers;
  2. converts it with ../tools/svg2rml.py (every group becomes a Node at the centre of its bounding box, so a flag
     or a person scales around its own middle);
  3. adds what moves. Per country, when it votes:
       flag    grows to 1.6x with an overshoot, with a glow in the vote colour behind it
       person  leans in (a small pop) with a soft glow behind
       table   the dark inner rim of its table segment takes the vote colour, the table top a light tint
       badge   a check (yes), cross (no) or dash (abstain) pops in, in the empty ring inside the table
     and everything goes back to the drawing as it was when the vote is set to none.

One enum per member state in the view model, named after its country code in lower case (`be`, `de`, ...):
none, yes, no, abstain. Each country has its own state-machine layer with those four states; every state moves to
the other three on the enum with a short cross-fade, and plays a one-shot pop.

The generated RML is a build product (8+ MB): the SVG and this script are the source. Standard library only."""
import io, math, os, re, shutil, subprocess, sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.join(HERE, 'rive')
BUILD = os.path.join(PROJECT, 'build')
SOURCE_SVG = os.path.join(HERE, 'eu-court.svg')
CLEAN_SVG = os.path.join(BUILD, 'eu-court-clean.svg')
RAW_RML = os.path.join(BUILD, 'eu-court-raw.rml')
RML = os.path.join(PROJECT, 'council-vote.rml')
SVG2RML = os.path.join(HERE, '..', 'tools', 'svg2rml.py')
SAMPLE = os.path.join(HERE, '..', '..', 'samples', 'eu-council-vote')

SVGNS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', SVGNS)
NS = '{%s}' % SVGNS

CLIENT = 11
M = 40.0                        # margin round the drawing, so the glows are not cut off
CX, CY = 566.22, 584.02         # centre of the table (the middle of the viewBox; every table segment is symmetric round it)
R_BADGE, BADGE = 240.0, 36.0    # the badges: in the empty ring between the wreath (r ~180) and the table's rim (r ~284)
FLAG_SCALE = 1.6                # how much a flag grows when its country votes
FLAG_GLOW = 30.0                # radius of the glow behind a flag (before it grows)
PERSON_SCALE = 1.06
PERSON_GLOW = 78.0

NAMES = {
    'AT': 'Austria', 'BE': 'Belgium', 'BG': 'Bulgaria', 'HR': 'Croatia', 'CY': 'Cyprus', 'CZ': 'Czechia',
    'DK': 'Denmark', 'EE': 'Estonia', 'FI': 'Finland', 'FR': 'France', 'DE': 'Germany', 'GR': 'Greece',
    'HU': 'Hungary', 'IE': 'Ireland', 'IT': 'Italy', 'LV': 'Latvia', 'LT': 'Lithuania', 'LU': 'Luxembourg',
    'MT': 'Malta', 'NL': 'Netherlands', 'PL': 'Poland', 'PT': 'Portugal', 'RO': 'Romania', 'SK': 'Slovakia',
    'SI': 'Slovenia', 'ES': 'Spain', 'SE': 'Sweden',
}
VOTES = ['none', 'yes', 'no', 'abstain']
VOTE_RGB = {'yes': '2E9E5B', 'no': 'D7263D', 'abstain': 'F0A21F'}
GLOW_RGB = {'none': 'FFFFFF', 'yes': '3FCF7A', 'no': 'F2445A', 'abstain': 'FFB52E'}
RIM_TINT, TOP_TINT = 1.0, 0.24  # how much of the vote colour the rim and the table top take


# ---------------------------------------------------------------------------------------------------------------
# 1. the SVG: plain ids, flags in a layer of their own
# ---------------------------------------------------------------------------------------------------------------

LAYERS = (('Midden', 'midden'), ('Stoelen', 'stoelen'), ('Tafel', 'tafel'), ('Personen', 'personen'))
INNER = {'stoel': 'stoelvorm', 'persoon': 'figuur', 'tafelrand_binnen': 'tafelrand', 'tafel_glans': 'glans'}


def clean_svg():
    tree = ET.parse(SOURCE_SVG)
    root = tree.getroot()
    layers = {}
    for g in list(root):
        gid = g.get('id') or ''
        for prefix, name in LAYERS:
            if gid.startswith(prefix):
                g.set('id', name); layers[name] = g
                g.attrib.pop('data-name', None)
    missing = [n for _, n in LAYERS if n not in layers]
    if missing:
        sys.exit('eu-court.svg: layer(s) not found: %s' % ', '.join(missing))

    singular = {'stoelen': 'stoel', 'tafel': 'tafel', 'personen': 'persoon'}
    countries = set()
    for layer, word in singular.items():
        for g in list(layers[layer]):
            code = (g.get('id') or '')[:2]
            if code not in NAMES:
                sys.exit('eu-court.svg: unknown country group %r in %s' % (g.get('id'), layer))
            countries.add(code)
            g.set('id', '%s-%s' % (word, code)); g.attrib.pop('data-name', None)
            for el in g.iter():
                eid = el.get('id') or ''
                if el is not g and eid.startswith(code + '_'):
                    rest = eid[3:]
                    el.set('id', '%s-%s' % (INNER.get(rest, rest.replace('_', '-')), code))
                el.attrib.pop('data-name', None)
    if len(countries) != 27:
        sys.exit('eu-court.svg: expected 27 countries, found %d' % len(countries))

    # the flags out of their table group, into one layer right above the table
    flags = ET.Element(NS + 'g', {'id': 'vlaggen'})
    for g in list(layers['tafel']):
        for child in list(g):
            if (child.get('id') or '').startswith('vlag-'):
                g.remove(child); flags.append(child)
    root.insert(list(root).index(layers['tafel']) + 1, flags)
    os.makedirs(BUILD, exist_ok=True)
    tree.write(CLEAN_SVG, encoding='utf-8', xml_declaration=True)
    return sorted(countries)


def convert():
    r = subprocess.run([sys.executable, SVG2RML, CLEAN_SVG, RAW_RML, '--name', 'CouncilVote', '--client', str(CLIENT)],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-3000:]); sys.exit('svg2rml failed')
    warnings = [l for l in r.stderr.splitlines() if l.startswith('svg2rml:')]
    for w in warnings[:10]: print('  ' + w)


# ---------------------------------------------------------------------------------------------------------------
# 2. what moves
# ---------------------------------------------------------------------------------------------------------------

_n = [100000]


def ID():
    """hand-made ids: from 100000, above svg2rml's range (its ids come from the names: 10000 to 99999)"""
    _n[0] += 1
    return '%d:%d' % (CLIENT, _n[0])


def f(v):
    return ('%.3f' % v).rstrip('0').rstrip('.') if isinstance(v, float) else str(v)


def el(xml):
    return ET.fromstring(xml)


def mix(a, b, t):
    """two RRGGBB colours, t of the way from a to b"""
    ca = [int(a[i:i + 2], 16) for i in (0, 2, 4)]; cb = [int(b[i:i + 2], 16) for i in (0, 2, 4)]
    return ''.join('%02X' % round(x + (y - x) * t) for x, y in zip(ca, cb))


def darker(c, t=0.25):
    return mix(c, '000000', t)


def glow_shape(name, x, y, radius, ids):
    """a soft round glow: radial gradient from the vote colour to transparent; the stops are keyed per vote"""
    return el('<Shape x="%s" y="%s" opacity="0" name="%s" id="%s"><Ellipse width="%s" height="%s" name="Path" id="%s"/>'
              '<Fill name="Fill" id="%s"><RadialGradient startX="0" startY="0" endX="%s" endY="0" name="Gradient" id="%s">'
              '<GradientStop colorValue="E6FFFFFF" position="0" id="%s"/><GradientStop colorValue="8CFFFFFF" position="0.5" id="%s"/>'
              '<GradientStop colorValue="00FFFFFF" position="1" id="%s"/></RadialGradient></Fill></Shape>'
              % (f(x), f(y), name, ids['glow'], f(2 * radius), f(2 * radius), ID(), ID(), f(radius), ID(),
                 ids['g0'], ids['g1'], ids['g2']))


def stroke_xml(color, w):
    return ('<Stroke thickness="%s" cap="round" join="round" name="Stroke" id="%s"><SolidColor colorValue="%s" name="Color" id="%s"/></Stroke>'
            % (f(w), ID(), color, ID()))


def open_path(points, name, sid):
    v = ''.join('<StraightVertex x="%s" y="%s" name="V" id="%s"/>' % (f(x), f(y), ID()) for x, y in points)
    return ('<Shape name="%s" id="%s"><PointsPath isClosed="false" name="Path" id="%s">%s</PointsPath>%s</Shape>'
            % (name, sid, ID(), v, stroke_xml('FFFFFFFF', 4.2)))


def badge(code, x, y, ids):
    return el('<Node x="%s" y="%s" opacity="0" name="badge-%s" id="%s">%s<Node name="cross" id="%s">%s%s</Node>%s'
              '<Shape name="disc" id="%s"><Ellipse width="%s" height="%s" name="Path" id="%s"/>%s'
              '<Fill name="Fill" id="%s"><SolidColor colorValue="FF2E9E5B" name="Color" id="%s"/></Fill></Shape>'
              '<Shape y="2.5" opacity="0.22" name="shadow" id="%s"><Ellipse width="%s" height="%s" name="Path" id="%s"/>'
              '<Fill name="Fill" id="%s"><SolidColor colorValue="FF0B1220" name="Color" id="%s"/></Fill></Shape></Node>'
              % (f(x), f(y), code, ids['badge'],
                 open_path([(-7.6, 0.4), (-2.5, 5.6), (7.9, -5.8)], 'check', ids['check']),
                 ids['cross'], open_path([(-5.9, -5.9), (5.9, 5.9)], 'stroke-1', ID()), open_path([(-5.9, 5.9), (5.9, -5.9)], 'stroke-2', ID()),
                 open_path([(-7.2, 0.0), (7.2, 0.0)], 'dash', ids['dash']),
                 ids['disc'], f(BADGE), f(BADGE), ID(), stroke_xml('FFFFFFFF', 3.0), ID(), ids['discc'],
                 ID(), f(BADGE + 5), f(BADGE + 5), ID(), ID(), ID()))


def kf(frame, value, ease=None, color=False):
    tag = 'KeyFrameColor' if color else 'KeyFrameDouble'
    v = value if color else f(float(value))
    if ease:
        return ('<%s value="%s" frame="%d" interpolationType="cubic" id="%s"><CubicEaseInterpolator x1="%s" y1="%s" x2="%s" y2="%s" id="%s"/></%s>'
                % (tag, v, frame, ID(), ease[0], ease[1], ease[2], ease[3], ID(), tag))
    return '<%s value="%s" frame="%d" interpolationType="linear" id="%s"/>' % (tag, v, frame, ID())


def keyed(obj, props):
    return ('<KeyedObject objectId="%s" id="%s">%s</KeyedObject>'
            % (obj, ID(), ''.join('<KeyedProperty propertyKey="%d" id="%s">%s</KeyedProperty>' % (k, ID(), ''.join(keys)) for k, keys in props)))


OUT = (0.2, 0.9, 0.3, 1.0)       # ease-out
BACK = (0.3, 1.7, 0.5, 1.0)      # ease-out with an overshoot: the pop


def pop(frames, rest, peak_ease=BACK):
    """from 1 to `rest`, overshooting on the way: [frame 0: 1, frame n: rest]"""
    return [kf(0, 1.0), kf(frames, rest, peak_ease)]


def animation(code, vote, ids, aid, orig):
    on = vote != 'none'
    rgb = VOTE_RGB.get(vote)
    glow = GLOW_RGB[vote]
    rim_fill = mix(orig['rim_fill'], rgb, RIM_TINT) if on else orig['rim_fill']
    rim_stroke = darker(rim_fill, 0.18) if on else orig['rim_stroke']
    top_fill = mix(orig['top_fill'], rgb, TOP_TINT) if on else orig['top_fill']
    top_stroke = mix(orig['top_stroke'], rgb, TOP_TINT) if on else orig['top_stroke']
    if on:
        blocks = [
            keyed(ids['flag'], [(16, pop(16, FLAG_SCALE)), (17, pop(16, FLAG_SCALE))]),
            keyed(ids['flagglow'], [(18, [kf(0, 0), kf(14, 1, OUT)])]),
            keyed(ids['person'], [(16, pop(14, PERSON_SCALE)), (17, pop(14, PERSON_SCALE))]),
            keyed(ids['personglow'], [(18, [kf(0, 0), kf(18, 1, OUT)])]),
            keyed(ids['badge'], [(18, [kf(0, 0), kf(7, 1, OUT)]),
                                 (16, [kf(0, 0.3), kf(13, 1.0, BACK)]),
                                 (17, [kf(0, 0.3), kf(13, 1.0, BACK)])]),
            keyed(ids['rimc'], [(37, [kf(0, 'FF' + orig['rim_fill'], color=True), kf(12, 'FF' + rim_fill, OUT, color=True)])]),
            keyed(ids['tintc'], [(37, [kf(0, 'FF' + orig['top_fill'], color=True), kf(12, 'FF' + top_fill, OUT, color=True)])]),
        ]
    else:
        blocks = [
            keyed(ids['flag'], [(16, [kf(0, 1.0)]), (17, [kf(0, 1.0)])]),
            keyed(ids['flagglow'], [(18, [kf(0, 0)])]),
            keyed(ids['person'], [(16, [kf(0, 1.0)]), (17, [kf(0, 1.0)])]),
            keyed(ids['personglow'], [(18, [kf(0, 0)])]),
            keyed(ids['badge'], [(18, [kf(0, 0)]), (16, [kf(0, 0.3)]), (17, [kf(0, 0.3)])]),
            keyed(ids['rimc'], [(37, [kf(0, 'FF' + rim_fill, color=True)])]),
            keyed(ids['tintc'], [(37, [kf(0, 'FF' + top_fill, color=True)])]),
        ]
    blocks += [
        keyed(ids['rims'], [(37, [kf(0, 'FF' + rim_stroke, color=True)])]),
        keyed(ids['tints'], [(37, [kf(0, 'FF' + top_stroke, color=True)])]),
        keyed(ids['discc'], [(37, [kf(0, 'FF' + (rgb or '9AA3AD'), color=True)])]),
        keyed(ids['check'], [(18, [kf(0, 1 if vote == 'yes' else 0)])]),
        keyed(ids['cross'], [(18, [kf(0, 1 if vote == 'no' else 0)])]),
        keyed(ids['dash'], [(18, [kf(0, 1 if vote == 'abstain' else 0)])]),
    ]
    for gid, alpha in (('fg0', 'E6'), ('fg1', '8C'), ('fg2', '00'), ('pg0', 'D9'), ('pg1', '73'), ('pg2', '00')):
        blocks.append(keyed(ids[gid], [(38, [kf(0, alpha + glow, color=True)])]))
    return '<LinearAnimation duration="%d" name="%s-%s" id="%s">%s</LinearAnimation>' % (22 if on else 1, code.lower(), vote, aid, ''.join(blocks))


def build(countries):
    tree = ET.parse(RAW_RML)
    root = tree.getroot()
    artboard = root.find('Artboard')
    drawing = artboard.find('Node')                       # svg2rml's root Node, origin (0, 0)

    # every Node by name, with its absolute position (x/y are relative to the parent's origin)
    nodes, absolute = {}, {}

    def walk(e, ox, oy):
        for c in e:
            if c.tag in ('Node', 'Shape'):
                ax, ay = ox + float(c.get('x', 0)), oy + float(c.get('y', 0))
                nodes[c.get('name')] = c; absolute[c.get('name')] = (ax, ay)
                walk(c, ax, ay)
    walk(drawing, 0.0, 0.0)

    def solid(shape, paint):
        sc = shape.find(paint).find('SolidColor')
        if sc.get('id') is None: sc.set('id', ID())
        return sc

    # the layers in Rive order (first child draws on top): personen, vlaggen, [glows], tafel, stoelen, midden
    order = [c.get('name') for c in drawing]
    glows = el('<Node name="glows" id="%s"/>' % ID())
    drawing.insert(order.index('tafel'), glows)
    badges = el('<Node name="badges" id="%s"/>' % ID())
    drawing.insert(0, badges)

    anims, layers, props, inst = [], [], [], []
    enum_ids = {v: '%d:%d' % (CLIENT, 60 + k) for k, v in enumerate(VOTES)}
    for i, code in enumerate(countries):
        flag, person = nodes['vlag-' + code], nodes['figuur-' + code]
        top, rim = nodes['tafelblad-' + code], nodes['tafelrand-' + code]
        ids = {k: ID() for k in ('flagglow', 'personglow', 'badge', 'disc', 'discc', 'check', 'cross', 'dash',
                                 'fg0', 'fg1', 'fg2', 'pg0', 'pg1', 'pg2')}
        ids['flag'], ids['person'] = flag.get('id'), person.get('id')
        ids['tintc'], ids['tints'] = solid(top, 'Fill').get('id'), solid(top, 'Stroke').get('id')
        ids['rimc'], ids['rims'] = solid(rim, 'Fill').get('id'), solid(rim, 'Stroke').get('id')
        orig = {'top_fill': top.find('Fill/SolidColor').get('colorValue')[2:], 'top_stroke': top.find('Stroke/SolidColor').get('colorValue')[2:],
                'rim_fill': rim.find('Fill/SolidColor').get('colorValue')[2:], 'rim_stroke': rim.find('Stroke/SolidColor').get('colorValue')[2:]}

        # the flag's glow goes inside the flag Node, last, so it draws behind the flag and grows with it
        flag.append(glow_shape('flagglow-' + code, 0.0, 0.0, FLAG_GLOW, {'glow': ids['flagglow'], 'g0': ids['fg0'], 'g1': ids['fg1'], 'g2': ids['fg2']}))
        # the person's glow in its own layer under the people and the flags, so it never covers a neighbour
        px, py = absolute['figuur-' + code]
        glows.append(glow_shape('glow-' + code, px, py, PERSON_GLOW, {'glow': ids['personglow'], 'g0': ids['pg0'], 'g1': ids['pg1'], 'g2': ids['pg2']}))
        # the badge on the line from the centre through the flag
        fx, fy = absolute['vlag-' + code]
        a = math.atan2(fy - CY, fx - CX)
        badges.append(badge(code, CX + R_BADGE * math.cos(a), CY + R_BADGE * math.sin(a), ids))

        prop = '%d:%d' % (CLIENT, 100 + i)
        props.append('<ViewModelPropertyEnumCustom enumId="%d:50" name="%s" id="%s"/>' % (CLIENT, code.lower(), prop))
        inst.append('<ViewModelInstanceEnum propertyValue="%s" viewModelPropertyId="%s" id="%s"/>' % (enum_ids['none'], prop, ID()))
        state_ids = {v: '%d:%d' % (CLIENT, 1000 + i * 10 + k) for k, v in enumerate(VOTES)}
        states = []
        for k, v in enumerate(VOTES):
            aid = '%d:%d' % (CLIENT, 700 + i * 10 + k)
            anims.append(animation(code, v, ids, aid, orig))
            trans = ''.join(
                '<StateTransition stateToId="%s" duration="160" id="%s"><TransitionViewModelCondition id="%s">'
                '<TransitionPropertyViewModelComparator id="%s"><BindablePropertyEnum id="%s">'
                '<DataBindContext sourcePathIds="%d:40-%s" propertyKey="637" id="%s"/></BindablePropertyEnum>'
                '</TransitionPropertyViewModelComparator><TransitionValueEnumComparator value="%s" id="%s"/>'
                '</TransitionViewModelCondition></StateTransition>'
                % (state_ids[w], ID(), ID(), ID(), ID(), CLIENT, prop, ID(), enum_ids[w], ID())
                for w in VOTES if w != v)
            states.append('<AnimationState x="%d" y="%d" animationId="%s" id="%s">%s</AnimationState>'
                          % (150 + k * 220, 120, aid, state_ids[v], trans))
        layers.append('<StateMachineLayer name="%s" id="%d:%d"><AnyState x="200" y="-120" id="%s"/><ExitState x="400" y="-120" id="%s"/>'
                      '<EntryState x="0" y="0" id="%s"><StateTransition stateToId="%s" id="%s"/></EntryState>%s</StateMachineLayer>'
                      % (code, CLIENT, 400 + i, ID(), ID(), ID(), state_ids['none'], ID(), ''.join(states)))

    # margin, so the glows of the outer seats are not cut off
    artboard.set('width', f(float(artboard.get('width')) + 2 * M))
    artboard.set('height', f(float(artboard.get('height')) + 2 * M))
    artboard.set('viewModelId', '%d:40' % CLIENT)
    drawing.set('x', f(M)); drawing.set('y', f(M))
    drawing.set('name', 'council')

    for old in artboard.findall('StateMachine'):     # svg2rml leaves an empty one with the same id
        artboard.remove(old)
    for a in anims: artboard.append(el(a))
    artboard.append(el('<StateMachine name="CouncilVote" id="%d:3">%s</StateMachine>' % (CLIENT, ''.join(layers))))
    root.append(el('<ViewModel defaultInstanceId="%d:41" name="CouncilVote" id="%d:40">%s'
                   '<ViewModelInstance exports="true" name="Default" id="%d:41">%s</ViewModelInstance></ViewModel>'
                   % (CLIENT, CLIENT, ''.join(props), CLIENT, ''.join(inst))))
    root.append(el('<DataEnumCustom name="Vote" id="%d:50">%s</DataEnumCustom>'
                   % (CLIENT, ''.join('<DataEnumValue key="%s" value="%s" id="%s"/>' % (v, v, enum_ids[v]) for v in VOTES))))

    head = ('<!-- EU Council vote. Generated by ../generate.py from ../eu-court.svg: edit those, not this file.\n'
            '     One enum per member state (country code in lower case): none, yes, no, abstain. Ids: client %d;\n'
            '     svg2rml 10000-99999 (from the names), hand-made below 1300 and from 100000. -->\n' % CLIENT)
    io.open(RML, 'w', encoding='utf-8', newline='\n').write(head + ET.tostring(root, encoding='unicode') + '\n')
    return float(artboard.get('width')), float(artboard.get('height'))


def rive_cli():
    exe = os.path.join(os.path.expanduser('~'), '.rive', 'bin', 'rive.exe' if os.name == 'nt' else 'rive')
    return exe if os.path.exists(exe) else 'rive'


def run(args):
    r = subprocess.run([rive_cli()] + args, env=dict(os.environ, RIVE_NO_TUI='1'), capture_output=True, text=True, encoding='utf-8', errors='replace')
    sys.stdout.write(r.stdout[-2000:]); sys.stderr.write(r.stderr[-2000:])
    return r.returncode


if __name__ == '__main__':
    countries = clean_svg()
    convert()
    w, h = build(countries)
    print('written: %s (%d countries, artboard %s x %s, %d KB)' % (os.path.relpath(RML), len(countries), f(w), f(h), os.path.getsize(RML) // 1024))
    if '--build' in sys.argv:
        if run([PROJECT, '--once']) != 0:
            sys.exit('rive --once failed')
        built = os.path.join(BUILD, 'eu-council-vote.riv')
        os.makedirs(SAMPLE, exist_ok=True)
        shutil.copy(built, os.path.join(SAMPLE, 'eu-council-vote.riv'))
        print('copied to samples/eu-council-vote/eu-council-vote.riv (%d KB)' % (os.path.getsize(built) // 1024))
