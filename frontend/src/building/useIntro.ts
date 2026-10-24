import gsap from 'gsap';
import { useCallback, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './geometry';

/** 0 -> 1 progress of each intro phase. The scene reads these every frame. */
export interface IntroProgress {
  wire: number; // wireframe draws in
  descend: number; // floors descend into place
  sensors: number; // sensor nodes activate
}

export const INTRO_DONE: IntroProgress = { wire: 1, descend: 1, sensors: 1 };

// Play once per page load: revisiting Observe shouldn't replay it.
let played = false;

/**
 * ~3.5 s intro: wireframe draws in (0-1.4 s), floors descend (0.9-2.4 s), sensors activate
 * (2.4-3.5 s). Skippable via `skip()`; skipped entirely under prefers-reduced-motion.
 */
export function useIntro(enabled: boolean) {
  const progress = useRef<IntroProgress>({ ...INTRO_DONE });
  const timeline = useRef<gsap.core.Timeline | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!enabled || played || prefersReducedMotion()) {
      played = true;
      progress.current = { ...INTRO_DONE };
      return;
    }
    const p: IntroProgress = { wire: 0, descend: 0, sensors: 0 };
    progress.current = p;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(true);
    const tl = gsap.timeline({
      onComplete: () => {
        played = true;
        setActive(false);
      },
    });
    tl.to(p, { wire: 1, duration: 1.4, ease: 'power2.inOut' }, 0)
      .to(p, { descend: 1, duration: 1.5, ease: 'power3.out' }, 0.9)
      .to(p, { sensors: 1, duration: 1.1, ease: 'back.out(1.6)' }, 2.4);
    timeline.current = tl;
    return () => {
      tl.kill();
      Object.assign(p, INTRO_DONE);
      timeline.current = null;
    };
  }, [enabled]);

  const skip = useCallback(() => {
    timeline.current?.progress(1);
  }, []);

  return { progress, active, skip };
}

/** Test hook: let the intro play again. */
export function resetIntroForTests(): void {
  played = false;
}
