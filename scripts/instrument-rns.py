"""Adds RNS_REPRO timing logs to react-native-screens (Android). Usage: python3 instrument_rns.py <rns root>"""
import sys, pathlib
root = pathlib.Path(sys.argv[1]) / 'android/src'
J = 'android.util.Log.i("RNS_REPRO", '
T = '"t=${android.os.SystemClock.uptimeMillis()} th=${Thread.currentThread().name} '
def patch(rel, old, new):
    p = root / rel
    s = p.read_text()
    if 'RNS_REPRO' in s and old not in s:
        return
    assert s.count(old) == 1, (rel, old)
    p.write_text(s.replace(old, new))
patch('fabric/java/com/swmansion/rnscreens/NativeProxy.kt',
      '        if (screen is Screen) {\n',
      '        if (screen is Screen) {\n            ' + J + T + 'notifyScreenRemoved screen=$screenTag")\n')
patch('main/java/com/swmansion/rnscreens/Screen.kt',
      '    fun startRemovalTransition() {\n',
      '    fun startRemovalTransition() {\n        ' + J + T + 'startRemovalTransition screen=$id started=$isRemovalTransitionStarted")\n')
patch('main/java/com/swmansion/rnscreens/Screen.kt',
      '    fun endRemovalTransition() {\n',
      '    fun endRemovalTransition() {\n        ' + J + T + 'endRemovalTransition screen=$id started=$isRemovalTransitionStarted from=${Throwable().stackTrace[1].methodName}")\n')
patch('main/java/com/swmansion/rnscreens/ScreenStackHeaderConfig.kt',
      '    fun removeConfigSubview(index: Int) {\n',
      '    fun removeConfigSubview(index: Int) {\n        ' + J + T + 'removeConfigSubview idx=$index count=${configSubviews.size} screen=${screen?.id} beingRemoved=${screen?.isBeingRemoved}")\n')
patch('main/java/com/swmansion/rnscreens/events/ScreenAnimationDelegate.kt',
      '    override fun onAnimationStart(animation: Animator) {\n',
      '    override fun onAnimationStart(animation: Animator) {\n        ' + J + T + 'animStart $animationType screen=${wrapper.screen.id} state=$currentState")\n')
patch('main/java/com/swmansion/rnscreens/events/ScreenAnimationDelegate.kt',
      '    override fun onAnimationEnd(animation: Animator) {\n',
      '    override fun onAnimationEnd(animation: Animator) {\n        ' + J + T + 'animEnd $animationType screen=${wrapper.screen.id} state=$currentState")\n')
print('ok')
