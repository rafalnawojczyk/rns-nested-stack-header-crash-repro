"""Per removal burst: offset of the removed screens' animation-end callbacks vs notifyScreenRemoved, and the window
(first header removal). Crash needs start < animEnd < headerRemoval."""
import re, sys
ev = [(int(m[1]), m[3], m[4]) for m in (re.search(r't=(\d+) th=(\S+) (\w+)(.*)', l) for l in sys.stdin) if m]
sid = lambda r: (re.search(r'screen=(\d+)', r) or [None, None])[1]
i = 0
while i < len(ev):
    if ev[i][1] != 'notifyScreenRemoved': i += 1; continue
    t0 = ev[i][0]; screens = set()
    while i < len(ev) and ev[i][1] == 'notifyScreenRemoved' and ev[i][0] - t0 < 5:
        screens.add(sid(ev[i][2])); i += 1
    ends = [t - t0 for t, k, r in ev if k == 'endRemovalTransition' and sid(r) in screens and abs(t - t0) < 700]
    rm = next((t - t0 for t, k, r in ev[i:] if k == 'removeConfigSubview' and sid(r) in screens), None)
    if rm is not None and rm < 2000: print(f'animEnds={ends} window={rm}ms')
