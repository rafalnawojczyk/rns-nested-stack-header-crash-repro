/**
 * Repro: Android crash (react-native-screens <= 4.30.1, Fabric)
 *   IllegalStateException: Cannot remove child at index 2 from parent ViewGroup […], only 2 children in parent.
 *   Caused by: ScreenStackFragment added into a non-stack container  (or: The specified child already has a parent)
 *     at ScreenStackHeaderConfig.onUpdate ← maybeUpdate ← removeConfigSubview ← ScreenStackHeaderConfigViewManager.removeViewAt
 *
 * Root native stack: Home (nested stack) and Feature (nested stack: Dashboard → Child, Child is another nested stack).
 * Pop Child, then pop the whole Feature navigator while the Dashboard reveal animation is still running.
 * NativeProxy.notifyScreenRemoved() posts Screen.startRemovalTransition() when the teardown is committed. When the
 * revealed Home screen does heavy JS work on refocus (refetch, setParams, re-render), the teardown mount is applied
 * hundreds of ms later. If the Dashboard reveal animation ends in between, ScreenStackFragment.notifyViewTransitionEnd()
 * calls Screen.endRemovalTransition() and resets isBeingRemoved, so the teardown's header subview removals run
 * ScreenStackHeaderConfig.onUpdate() on a screen that is being destroyed → crash.
 */
import React, { createContext, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Linking, Pressable, Text, View } from 'react-native';
import {
  createNavigationContainerRef,
  NavigationContainer,
  useFocusEffect,
  useIsFocused,
  useNavigation,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

type RootParams = { Home: undefined; Feature: undefined };

const Root = createNativeStackNavigator<RootParams>();
const HomeStack = createNativeStackNavigator<{ HomeScreen: { revalidate?: boolean } | undefined }>();
const FeatureStack = createNativeStackNavigator<{ Dashboard: undefined; Child: undefined }>();
const ChildStack = createNativeStackNavigator<{ ChildRoot: undefined }>();
const navigationRef = createNavigationContainerRef<RootParams>();

// JS cost of re-rendering the Home screen. A large app in a debug build easily spends hundreds of ms here; in the app
// this repro is based on, the teardown mount landed ~1 s after notifyScreenRemoved. Set to 0 to see the race close.
const HOME_RENDER_COST_MS = 300;
// Delay between popping Child and popping Feature (~0.3–0.4 s between two hardware back presses in the original).
const GAPS_MS = [250, 300, 350, 400];

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// Provided by React Native at runtime, missing from its TS lib.
declare function requestIdleCallback(callback: () => void): number;
declare function cancelIdleCallback(id: number): void;
const burn = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
};

// A cache-first query that refetches on demand, like a data-fetching hook in a real app.
function useFakeQuery(latencyMs: number, enabled = true) {
  const [state, setState] = useState<{ data?: number; isFetching: boolean }>({ isFetching: enabled });
  const refetch = useCallback(() => {
    setState(s => ({ ...s, isFetching: true }));
    setTimeout(() => setState({ data: Date.now(), isFetching: false }), latencyMs);
  }, [latencyMs]);
  useEffect(() => {
    if (enabled) refetch();
  }, [enabled, refetch]);
  return { ...state, refetch };
}

// Flips to true once the JS thread is idle after focus, back to false on blur (gates "after transition" fetches).
function useHasFinishedTransition() {
  const [finished, setFinished] = useState(false);
  useFocusEffect(
    useCallback(() => {
      const id = requestIdleCallback(() => setFinished(true));
      return () => {
        cancelIdleCallback(id);
        setFinished(false);
      };
    }, []),
  );
  return finished;
}

function HeaderButton({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderRadius: 16 }}>
      <Text>{label}</Text>
    </Pressable>
  );
}

// Same shape as a typical custom header hook: re-applied via setOptions on every render (the rest object is new every
// time), transparent header with a background component, custom left/title, right button only once data is ready.
function useCustomHeader({ title, rightLabel, ...rest }: { title: string; rightLabel?: string; [key: string]: unknown }) {
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({
      headerBackVisible: false,
      headerLeft: () => <HeaderButton label="←" onPress={() => navigation.goBack()} />,
      headerTitle: () => <Text style={{ fontSize: 18, fontWeight: '600' }}>{title}</Text>,
      headerRight: rightLabel ? () => <HeaderButton label={rightLabel} /> : undefined,
      headerTitleAlign: 'center',
      headerStyle: { backgroundColor: 'transparent' },
      headerTransparent: true,
      headerBackground: () => <View style={{ flex: 1, backgroundColor: 'white', opacity: 0.92, borderBottomWidth: 1 }} />,
      ...rest,
    });
  });
}

function Tiles({ count, seed }: { count: number; seed: number }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ width: 8, height: 8, margin: 1, backgroundColor: (i + seed) % 2 ? '#ccc' : '#999' }} />
      ))}
    </View>
  );
}

// ---- Home: the screen revealed when Feature is popped. On focus it refetches everything and clears a route param.
function HomeScreen({ navigation, route }: any) {
  const isFocused = useIsFocused();
  const items = useFakeQuery(80);
  const header = useFakeQuery(120);
  const alerts = useFakeQuery(60);
  useFocusEffect(
    useCallback(() => {
      items.refetch();
      header.refetch();
      alerts.refetch();
      navigation.setParams({ revalidate: false });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [navigation]),
  );
  burn(HOME_RENDER_COST_MS); // stands in for rendering a large screen in a debug build

  return (
    <View style={{ flex: 1, alignItems: 'center', paddingTop: 100 }}>
      <AutoRepro />
      <Text>
        focused={String(isFocused)} revalidate={String(route.params?.revalidate)} fetching=
        {String(items.isFetching || header.isFetching || alerts.isFetching)}
      </Text>
      <Tiles count={600} seed={items.data ?? 0} />
    </View>
  );
}

function HomeNavigator() {
  return (
    <HomeStack.Navigator>
      <HomeStack.Screen name="HomeScreen" component={HomeScreen} options={{ title: 'Home' }} />
    </HomeStack.Navigator>
  );
}

// ---- Feature: provider + nested stack. Dashboard shows a loader until its data is in, then a large screen.
const FeatureContext = createContext<number | undefined>(undefined);

function FeatureProvider({ children }: { children: React.ReactNode }) {
  const { data } = useFakeQuery(100);
  return <FeatureContext.Provider value={data}>{children}</FeatureContext.Provider>;
}

function Dashboard({ navigation }: any) {
  const finished = useHasFinishedTransition();
  const isFocused = useIsFocused();
  const account = useFakeQuery(150, finished);
  const details = useFakeQuery(90, finished && isFocused);
  const transactions = useFakeQuery(130, isFocused);
  const cards = useFakeQuery(70);
  const ready = account.data != null;

  useCustomHeader({ title: 'Dashboard', rightLabel: ready ? 'More' : undefined });

  useFocusEffect(
    useCallback(() => {
      cards.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  if (!ready) {
    return <Text style={{ marginTop: 120, textAlign: 'center' }}>Loading…</Text>;
  }
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingTop: 100 }}>
      <Button testID="open-child" title="Open child" onPress={() => navigation.navigate('Child')} />
      <Tiles count={1500} seed={(details.data ?? 0) + (transactions.data ?? 0)} />
    </View>
  );
}

function ChildRoot() {
  const finished = useHasFinishedTransition();
  useFakeQuery(100, !finished);
  useCustomHeader({ title: 'Child' });
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingTop: 100 }}>
      <Text>Child – press back twice quickly</Text>
      <Tiles count={800} seed={0} />
    </View>
  );
}

function ChildNavigator() {
  return (
    <ChildStack.Navigator>
      <ChildStack.Screen name="ChildRoot" component={ChildRoot} />
    </ChildStack.Navigator>
  );
}

function FeatureNavigator() {
  return (
    <FeatureProvider>
      <FeatureStack.Navigator>
        <FeatureStack.Screen name="Dashboard" component={Dashboard} />
        <FeatureStack.Screen name="Child" component={ChildNavigator} options={{ headerShown: false }} />
      </FeatureStack.Navigator>
    </FeatureProvider>
  );
}

// ---- Auto repro loop. `adb shell am start -d rnsrepro://auto com.rnsnestedrepro` starts it without tapping.
function AutoRepro() {
  const [running, setRunning] = useState(false);
  const [iteration, setIteration] = useState(0);
  const runningRef = useRef(false);

  useEffect(() => {
    const startIfAuto = (url?: string | null) => {
      if (url?.startsWith('rnsrepro://auto')) setRunning(true);
    };
    Linking.getInitialURL().then(startIfAuto);
    const subscription = Linking.addEventListener('url', ({ url }) => startIfAuto(url));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    runningRef.current = running;
    if (!running) return;
    (async () => {
      for (let i = 1; runningRef.current; i++) {
        const gap = GAPS_MS[i % GAPS_MS.length];
        setIteration(i);
        console.warn(`[repro] iteration ${i} gap ${gap}ms`);
        navigationRef.navigate('Feature');
        await wait(2000);
        (navigationRef as any).navigate('Feature', { screen: 'Child' });
        await wait(1500);
        navigationRef.goBack(); // pops Child inside the nested stack → Dashboard reveal animation starts
        await wait(gap);
        navigationRef.goBack(); // pops the whole Feature navigator while that animation is still running
        await wait(2000);
      }
    })();
  }, [running]);

  return (
    <View style={{ alignItems: 'center', gap: 8 }}>
      <Button testID="open-feature" title="Open feature" onPress={() => navigationRef.navigate('Feature')} />
      <Button testID="auto-repro" title={running ? 'Stop auto repro' : 'Start auto repro'} onPress={() => setRunning(r => !r)} />
      <Text testID="iteration">Iteration: {iteration}</Text>
    </View>
  );
}

export default function App() {
  return (
    <NavigationContainer ref={navigationRef}>
      <Root.Navigator screenOptions={{ headerShown: false }}>
        <Root.Screen name="Home" component={HomeNavigator} options={{ animation: 'fade' }} />
        <Root.Screen name="Feature" component={FeatureNavigator} />
      </Root.Navigator>
    </NavigationContainer>
  );
}
