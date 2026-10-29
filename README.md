# react-native-screens: header crash when a nested native stack is popped mid-transition (Android, Fabric)

Minimal repro for an Android crash in react-native-screens **4.30.1** (also 4.28.0), New Architecture:

```
java.lang.IllegalStateException: Cannot remove child at index 2 from parent ViewGroup [...], only 2 children in parent. Warning: childCount may be incorrect!
    at com.facebook.react.fabric.mounting.SurfaceMountingManager.removeViewAt
Caused by: java.lang.IllegalStateException: The specified child already has a parent. You must call removeView() on the child's parent first.
    at android.view.ViewGroup.addView
    at com.swmansion.rnscreens.ScreenStackHeaderConfig.onUpdate
    at com.swmansion.rnscreens.ScreenStackHeaderConfig.maybeUpdate
    at com.swmansion.rnscreens.ScreenStackHeaderConfig.removeConfigSubview
    at com.swmansion.rnscreens.ScreenStackHeaderConfigViewManager.removeViewAt
```

(4.28.0 can also show `Caused by: ScreenStackFragment added into a non-stack container` from the same frames.)

## Navigator shape

```
Root native stack
├─ Home      → nested native stack (re-fetches, setParams and re-renders on focus)
└─ Feature   → nested native stack
   ├─ Dashboard  (custom headerLeft / headerTitle / headerRight)
   └─ Child      (nested navigator)
```

On `Child`, press back twice quickly: the first back pops `Child` (Dashboard slides back in), the second pops the
whole `Feature` navigator while that reveal animation is still running.

## Versions

| Package | Version |
|---|---|
| react-native | 0.87.1 (New Architecture) |
| react-native-screens | 4.30.1 |
| @react-navigation/native | 7.5.0 |
| @react-navigation/native-stack | 7.20.0 |
| react-native-safe-area-context | 5.10.1 |

## Run

```sh
npm install
npm start                      # terminal 1 (Metro)
npm run android                # terminal 2 (debug build on an emulator)
scripts/run-auto-repro.sh 120  # launches rnsrepro://auto, which starts an in-app loop doing the double back
```

The loop usually crashes on iteration 1–2 (~20 s). You can also tap **Start auto repro**, or do it by hand:
Open feature → Open child → press system back twice ~0.2–0.5 s apart.

`HOME_RENDER_COST_MS` in `App.tsx` controls how much JS work the revealed Home screen does. 300 crashes almost
immediately; 0 still crashes, but only after a few minutes.

## Cause

`NativeProxy.notifyScreenRemoved()` posts `Screen.startRemovalTransition()` when the teardown is committed. If the
Dashboard's **enter** animation ends before Fabric mounts the teardown, `ScreenStackFragment.notifyViewTransitionEnd()`
calls `Screen.endRemovalTransition()`, which resets `isBeingRemoved` because its guard only checks
`isRemovalTransitionStarted`. The teardown's header-subview removals then run `ScreenStackHeaderConfig.onUpdate()` on a
screen that is being destroyed. JS work on the revealed screen delays the teardown mount, which widens the window.

Proposed fix: only an exit animation may finish a removal transition.

```diff
--- a/android/src/main/java/com/swmansion/rnscreens/ScreenStackFragment.kt
+++ b/android/src/main/java/com/swmansion/rnscreens/ScreenStackFragment.kt
-        // Rely on guards inside the callee to detect whether this was indeed removal transition.
-        screen.endRemovalTransition()
+        // Only an exit animation finishes a removal transition. An enter animation that ends after the
+        // removal has already started (e.g. a quick second back) must not reset `isBeingRemoved`.
+        if (isRemoving) {
+            screen.endRemovalTransition()
+        }
--- a/android/src/main/java/com/swmansion/rnscreens/events/ScreenAnimationDelegate.kt
+++ b/android/src/main/java/com/swmansion/rnscreens/events/ScreenAnimationDelegate.kt
-            wrapper.screen.endRemovalTransition()
+            if (isExitAnimation) {
+                wrapper.screen.endRemovalTransition()
+            }
```

## Timing helpers

`scripts/instrument-rns.py node_modules/react-native-screens` adds temporary `RNS_REPRO` logs to the library (rebuild
afterwards, reinstall the package to undo). `adb logcat -d -s RNS_REPRO | python3 scripts/race-windows.py` then prints
the race window per removal.
