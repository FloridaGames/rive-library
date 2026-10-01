# -*- coding: utf-8 -*-
"""EU Council vote: a round-table illustration where code highlights each member state's vote.

  python sources/eu-council-vote/generate.py           # writes rive/council-vote.rml
  python sources/eu-council-vote/generate.py --build   # ... and builds samples/eu-council-vote/eu-council-vote.riv

The illustration (rive/council-table.webp) goes into the file untouched, as an ImageAsset. Everything that moves
lies on top of it (or, for the glow, underneath), per seat:

  strip  a coloured light along the table's inner edge, in front of the member
  badge  a round badge in the empty ring inside the table: check (yes), cross (no) or dash (abstain); it pops in
  glow   a soft glow behind the chair, drawn under the picture so it only shows around the chair's outline

One enum per member state in the view model, named after its country code in lower case (`de`, `fr`, ...):
none, yes, no, abstain. Each member has its own state-machine layer with those four states; every state
transitions to the other three on the enum, with a short cross-fade, and plays a one-shot pop.

The picture has 25 seats: Bulgaria and Slovakia have none. Its background was cut out with the black stripes of three
flags (Germany, Belgium, Estonia): those are transparent holes, so they show the page colour. A black patch under
each hole fills it in, and the flags look exactly as drawn. The holes were found by flooding the transparency from
the edges and the empty ring; what stays transparent is enclosed.

Seat angles were measured from the picture: degrees clockwise from the top, around the centre of the table's inner
edge. Standard library only."""
import io, math, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.join(HERE, 'rive')
RML = os.path.join(PROJECT, 'council-vote.rml')
SAMPLE = os.path.join(HERE, '..', '..', 'samples', 'eu-council-vote')

IMG = 1254.0                  # the picture is 1254 x 1254
M = 48.0                      # margin around it, so the glows are not cut off at the edge
AB = IMG + 2 * M              # artboard
CX, CY = 618.5, 640.2         # centre of the table's inner edge, in picture pixels (circle fit)
R_IN, R_OUT = 315.0, 346.0    # the darker band along the table's inner edge: the light strip
R_BADGE, BADGE = 274.0, 40.0  # badges sit in the empty ring between the wreath (r ~180) and the table (r 312)
R_GLOW, GLOW = 528.0, 132.0   # behind the chair; radius of the glow
GAP = 0.7                     # degrees left free between two strips

# code, name, seat angle (degrees clockwise from the top)
SEATS = [
    ('DE', 'Germany', 0.2), ('ES', 'Spain', 15.7), ('FI', 'Finland', 31.5), ('FR', 'France', 47.3),
    ('EE', 'Estonia', 62.0), ('RO', 'Romania', 76.2), ('IT', 'Italy', 90.4), ('LV', 'Latvia', 104.3),
    ('HR', 'Croatia', 117.9), ('HU', 'Hungary', 131.9), ('NL', 'Netherlands', 146.4), ('LT', 'Lithuania', 159.8),
    ('SI', 'Slovenia', 172.2), ('CZ', 'Czechia', 186.9), ('CY', 'Cyprus', 200.7), ('PT', 'Portugal', 215.2),
    ('BE', 'Belgium', 229.1), ('AT', 'Austria', 243.1), ('SE', 'Sweden', 256.4), ('PL', 'Poland', 269.6),
    ('DK', 'Denmark', 284.4), ('IE', 'Ireland', 299.0), ('GR', 'Greece', 315.0), ('LU', 'Luxembourg', 330.1),
    ('MT', 'Malta', 344.5),
]

VOTES = ['none', 'yes', 'no', 'abstain']
COLOR = {'none': 'FF9AA3AD', 'yes': 'FF2E9E5B', 'no': 'FFD7263D', 'abstain': 'FFF0A21F'}
GLOW_RGB = {'none': '9AA3AD', 'yes': '34C46E', 'no': 'F0334A', 'abstain': 'FFB020'}

# the transparent holes in the picture (the black flag stripes): bounding box x0, x1, y0, y1 in picture pixels.
# The patch lies under the picture, so it only shows through the hole.
HOLES = [('DE', 602, 638, 256, 263), ('BE', 310, 338, 883, 912), ('EE', 947, 968, 446, 476)]
BLACK = 'FF15161A'

_n = [10000]                  # generated ids; 11:2000+ animations and 11:3000+ states are fixed


def ID():
    _n[0] += 1
    return '11:%d' % _n[0]


def f(v):
    return ('%.3f' % v).rstrip('0').rstrip('.') if isinstance(v, float) else str(v)


def at(r, deg):
    t = math.radians(deg)
    return CX + r * math.sin(t), CY - r * math.cos(t)


def fill(color, cid=None):
    return '<Fill name="Fill" id="%s"><SolidColor colorValue="%s" name="Color" id="%s"/></Fill>' % (ID(), color, cid or ID())


def stroke(color, w, cid=None, cap='round'):
    return ('<Stroke thickness="%s" cap="%s" join="round" name="Stroke" id="%s"><SolidColor colorValue="%s" name="Color" id="%s"/></Stroke>'
            % (f(w), cap, ID(), color, cid or ID()))


def path(points, closed, paint, name, sid=None, opacity=None):
    v = ''.join('<StraightVertex x="%s" y="%s" name="V" id="%s"/>' % (f(x), f(y), ID()) for x, y in points)
    return ('<Shape%s name="%s" id="%s"><PointsPath isClosed="%s" name="Path" id="%s">%s</PointsPath>%s</Shape>'
            % ('' if opacity is None else ' opacity="%s"' % f(opacity), name, sid or ID(), 'true' if closed else 'false', ID(), v, paint))


def rect(x, y, w, h, color, name):
    return ('<Shape x="%s" y="%s" name="%s" id="%s"><Rectangle width="%s" height="%s" name="Path" id="%s"/>%s</Shape>'
            % (f(x), f(y), name, ID(), f(w), f(h), ID(), fill(color)))


def sector(a0, a1):
    """the light strip: an annular sector along the table's inner edge, one point per degree"""
    n = max(4, int(abs(a1 - a0)) + 1)
    outer = [at(R_OUT, a0 + (a1 - a0) * i / n) for i in range(n + 1)]
    inner = [at(R_IN, a1 - (a1 - a0) * i / n) for i in range(n + 1)]
    return outer + inner


def bounds(i):
    """from halfway to the previous seat to halfway to the next one, minus a small gap"""
    a = SEATS[i][2]
    prev, nxt = SEATS[i - 1][2], SEATS[(i + 1) % len(SEATS)][2]
    left = a - ((a - prev) % 360) / 2 + GAP
    right = a + ((nxt - a) % 360) / 2 - GAP
    return left, right


def seat(i):
    code, name, a = SEATS[i]
    ids = {k: ID() for k in ('strip', 'stripc', 'badge', 'disc', 'discc', 'check', 'cross', 'dash', 'glow', 'g0', 'g1', 'g2')}

    left, right = bounds(i)
    strip = path(sector(left, right), True, fill(COLOR['yes'], ids['stripc']), 'strip-' + code, sid=ids['strip'], opacity=0.0)

    bx, by = at(R_BADGE, a)
    r = BADGE / 2
    glyphs = ''.join([
        path([(-8.5, 0.5), (-2.8, 6.2), (8.8, -6.4)], False, stroke('FFFFFFFF', 4.6), 'check', sid=ids['check']),
        ('<Node name="cross" id="%s">%s%s</Node>' % (ids['cross'],
                                                     path([(-6.6, -6.6), (6.6, 6.6)], False, stroke('FFFFFFFF', 4.6), 'stroke-1'),
                                                     path([(-6.6, 6.6), (6.6, -6.6)], False, stroke('FFFFFFFF', 4.6), 'stroke-2'))),
        path([(-8.0, 0.0), (8.0, 0.0)], False, stroke('FFFFFFFF', 4.6), 'dash', sid=ids['dash']),
    ])
    disc = ('<Shape name="disc" id="%s"><Ellipse width="%s" height="%s" name="Path" id="%s"/>%s%s</Shape>'
            % (ids['disc'], f(BADGE), f(BADGE), ID(), stroke('FFFFFFFF', 3.2), fill(COLOR['yes'], ids['discc'])))
    shadow = ('<Shape y="2.5" opacity="0.22" name="shadow" id="%s"><Ellipse width="%s" height="%s" name="Path" id="%s"/>%s</Shape>'
              % (ID(), f(BADGE + 5), f(BADGE + 5), ID(), fill('FF0B1220')))
    badge = ('<Node x="%s" y="%s" opacity="0" name="badge-%s" id="%s">%s%s%s</Node>'
             % (f(bx), f(by), code, ids['badge'], glyphs, disc, shadow))

    gx, gy = at(R_GLOW, a)
    rgb = GLOW_RGB['yes']
    glow = ('<Shape x="%s" y="%s" opacity="0" name="glow-%s" id="%s"><Ellipse width="%s" height="%s" name="Path" id="%s"/>'
            '<Fill name="Fill" id="%s"><RadialGradient startX="0" startY="0" endX="%s" endY="0" name="Gradient" id="%s">'
            '<GradientStop colorValue="E6%s" position="0" id="%s"/><GradientStop colorValue="8C%s" position="0.55" id="%s"/>'
            '<GradientStop colorValue="00%s" position="1" id="%s"/></RadialGradient></Fill></Shape>'
            % (f(gx), f(gy), code, ids['glow'], f(2 * GLOW), f(2 * GLOW), ID(), ID(), f(GLOW), ID(),
               rgb, ids['g0'], rgb, ids['g1'], rgb, ids['g2']))
    return strip, badge, glow, ids


def patch(code, x0, x1, y0, y1):
    """black under a hole; 3 px wider all round, for the anti-aliased edge"""
    return rect((x0 + x1) / 2.0, (y0 + y1) / 2.0, x1 - x0 + 7.0, y1 - y0 + 7.0, BLACK, 'stripe-' + code)


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


OUT = (0.2, 0.9, 0.3, 1.0)      # ease-out
BACK = (0.3, 1.6, 0.5, 1.0)     # ease-out with overshoot


def animation(code, vote, ids, aid):
    """one state of one seat. none: everything off. yes/no/abstain: the strip, the badge and the glow come in, in
    that vote's colour, and the badge pops"""
    on = vote != 'none'
    c, rgb = COLOR[vote], GLOW_RGB[vote]
    if on:
        blocks = [
            keyed(ids['strip'], [(18, [kf(0, 0), kf(12, 0.95, OUT)])]),
            keyed(ids['badge'], [(18, [kf(0, 0), kf(7, 1, OUT)]),
                                 (16, [kf(0, 0.3), kf(13, 1.0, BACK), kf(20, 1.0)]),
                                 (17, [kf(0, 0.3), kf(13, 1.0, BACK), kf(20, 1.0)])]),
            keyed(ids['glow'], [(18, [kf(0, 0), kf(18, 1, OUT)])]),
        ]
    else:
        blocks = [keyed(ids['strip'], [(18, [kf(0, 0)])]),
                  keyed(ids['badge'], [(18, [kf(0, 0)]), (16, [kf(0, 0.3)]), (17, [kf(0, 0.3)])]),
                  keyed(ids['glow'], [(18, [kf(0, 0)])])]
    blocks += [
        keyed(ids['stripc'], [(37, [kf(0, c, color=True)])]),
        keyed(ids['discc'], [(37, [kf(0, c, color=True)])]),
        keyed(ids['g0'], [(38, [kf(0, 'E6' + rgb, color=True)])]),
        keyed(ids['g1'], [(38, [kf(0, '8C' + rgb, color=True)])]),
        keyed(ids['g2'], [(38, [kf(0, '00' + rgb, color=True)])]),
        keyed(ids['check'], [(18, [kf(0, 1 if vote == 'yes' else 0)])]),
        keyed(ids['cross'], [(18, [kf(0, 1 if vote == 'no' else 0)])]),
        keyed(ids['dash'], [(18, [kf(0, 1 if vote == 'abstain' else 0)])]),
    ]
    return '<LinearAnimation duration="%d" name="%s-%s" id="%s">%s</LinearAnimation>' % (20 if on else 1, code.lower(), vote, aid, ''.join(blocks))


def build():
    strips, badges, glows, anims, layers, props, inst = [], [], [], [], [], [], []
    enum_ids = {v: '11:%d' % (60 + k) for k, v in enumerate(VOTES)}
    for i, (code, name, a) in enumerate(SEATS):
        strip, badge, glow, ids = seat(i)
        strips.append(strip); badges.append(badge); glows.append(glow)
        prop = '11:%d' % (100 + i)
        props.append('<ViewModelPropertyEnumCustom enumId="11:50" name="%s" id="%s"/>' % (code.lower(), prop))
        inst.append('<ViewModelInstanceEnum propertyValue="%s" viewModelPropertyId="%s" id="%s"/>' % (enum_ids['none'], prop, ID()))

        state_ids = {v: '11:%d' % (3000 + i * 10 + k) for k, v in enumerate(VOTES)}
        states = []
        for k, v in enumerate(VOTES):
            aid = '11:%d' % (2000 + i * 10 + k)
            anims.append(animation(code, v, ids, aid))
            trans = ''.join(
                '<StateTransition stateToId="%s" duration="160" id="%s"><TransitionViewModelCondition id="%s">'
                '<TransitionPropertyViewModelComparator id="%s"><BindablePropertyEnum id="%s">'
                '<DataBindContext sourcePathIds="11:40-%s" propertyKey="637" id="%s"/></BindablePropertyEnum>'
                '</TransitionPropertyViewModelComparator><TransitionValueEnumComparator value="%s" id="%s"/>'
                '</TransitionViewModelCondition></StateTransition>'
                % (state_ids[w], ID(), ID(), ID(), ID(), prop, ID(), enum_ids[w], ID())
                for w in VOTES if w != v)
            states.append('<AnimationState x="%d" y="%d" animationId="%s" id="%s">%s</AnimationState>'
                          % (150 + k * 220, 120, aid, state_ids[v], trans))
        layers.append('<StateMachineLayer name="%s" id="11:%d"><AnyState x="200" y="-120" id="%s"/><ExitState x="400" y="-120" id="%s"/>'
                      '<EntryState x="0" y="0" id="%s"><StateTransition stateToId="%s" id="%s"/></EntryState>%s</StateMachineLayer>'
                      % (code, 500 + i, ID(), ID(), ID(), state_ids['none'], ID(), ''.join(states)))

    patches = ''.join(patch(*h) for h in HOLES)
    image = '<Image x="%s" y="%s" assetId="11:900" name="council-table" id="11:20"/>' % (f(IMG / 2), f(IMG / 2))
    # first child draws on top: badges, strips, the picture, then underneath it the flag patches and the glows
    scene = ('<Node x="%s" y="%s" name="scene" id="11:10"><Node name="badges" id="11:11">%s</Node><Node name="strips" id="11:12">%s</Node>'
             '%s<Node name="flag-patches" id="11:13">%s</Node><Node name="glows" id="11:14">%s</Node></Node>'
             % (f(M), f(M), ''.join(badges), ''.join(strips), image, patches, ''.join(glows)))
    sm = '<StateMachine name="CouncilVote" id="11:3">%s</StateMachine>' % ''.join(layers)
    artboard = ('<Artboard defaultStateMachineId="11:3" viewModelId="11:40" styleId="11:6" width="%s" height="%s" name="CouncilVote" id="11:2">'
                '<LayoutComponentStyle name="Artboard Style" id="11:6"/>%s%s%s</Artboard>'
                % (f(AB), f(AB), scene, ''.join(anims), sm))
    enum = ('<DataEnumCustom name="Vote" id="11:50">%s</DataEnumCustom>'
            % ''.join('<DataEnumValue key="%s" value="%s" id="%s"/>' % (v, v, enum_ids[v]) for v in VOTES))
    vm = ('<ViewModel defaultInstanceId="11:41" name="CouncilVote" id="11:40">%s'
          '<ViewModelInstance exports="true" name="Default" id="11:41">%s</ViewModelInstance></ViewModel>'
          % (''.join(props), ''.join(inst)))
    asset = '<ImageAsset file="council-table.webp" name="council-table" id="11:900"/>'
    head = ('<!-- EU Council vote. Generated by ../generate.py: edit that script and run it again, not this file.\n'
            '     One enum per member state (country code in lower case): none, yes, no, abstain. 25 seats; Bulgaria and\n'
            '     Slovakia have none in this picture. Ids: client 11. -->\n')
    return head + '<Rive version="1" kind="fragment">' + artboard + vm + enum + asset + '</Rive>\n'


def rive_cli():
    exe = os.path.join(os.path.expanduser('~'), '.rive', 'bin', 'rive.exe' if os.name == 'nt' else 'rive')
    return exe if os.path.exists(exe) else 'rive'


def run(args):
    r = subprocess.run([rive_cli()] + args, env=dict(os.environ, RIVE_NO_TUI='1'), capture_output=True, text=True, encoding='utf-8', errors='replace')
    sys.stdout.write(r.stdout[-2000:]); sys.stderr.write(r.stderr[-2000:])
    return r.returncode


if __name__ == '__main__':
    io.open(RML, 'w', encoding='utf-8', newline='\n').write(build())
    print('written: %s (%d seats)' % (os.path.relpath(RML), len(SEATS)))
    if '--build' in sys.argv:
        if run([PROJECT, '--once']) != 0:
            sys.exit('rive --once failed')
        built = os.path.join(PROJECT, 'build', 'eu-council-vote.riv')
        os.makedirs(SAMPLE, exist_ok=True)
        shutil.copy(built, os.path.join(SAMPLE, 'eu-council-vote.riv'))
        print('copied to samples/eu-council-vote/eu-council-vote.riv (%d KB)' % (os.path.getsize(built) // 1024))
