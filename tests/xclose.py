# Sends WM_DELETE_WINDOW to windows whose title matches (what clicking the window's X button does)
import sys, re
from Xlib import display, X, protocol
d = display.Display(':99'); root = d.screen().root
pat = re.compile(sys.argv[1])
WM_PROTOCOLS = d.intern_atom('WM_PROTOCOLS'); WM_DELETE = d.intern_atom('WM_DELETE_WINDOW'); NET_NAME = d.intern_atom('_NET_WM_NAME'); UTF8 = d.intern_atom('UTF8_STRING')
def walk(w):
    try:
        for c in w.query_tree().children:
            yield c; yield from walk(c)
    except Exception: return
n = 0
for w in walk(root):
    try:
        p = w.get_full_property(NET_NAME, UTF8); name = p.value.decode() if p else (w.get_wm_name() or '')
    except Exception: continue
    if name and pat.search(name):
        ev = protocol.event.ClientMessage(window=w, client_type=WM_PROTOCOLS, data=(32, [WM_DELETE, X.CurrentTime, 0, 0, 0]))
        w.send_event(ev, event_mask=X.NoEventMask); n += 1
d.flush(); print('enviado para', n, 'janela(s)')
