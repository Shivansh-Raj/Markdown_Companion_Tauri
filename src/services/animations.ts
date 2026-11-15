const KEY = "mdc-animations";

export function animationsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

/** Reflects the preference on <html data-anim>. CSS also respects the OS reduce-motion setting. */
export function applyAnimationPref() {
  document.documentElement.dataset.anim = animationsEnabled() ? "on" : "off";
}

export function setAnimationsEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable: the choice just won't persist */
  }
  applyAnimationPref();
}

/** Keeps every window in sync when the setting is changed in another one. */
export function watchAnimationPref() {
  applyAnimationPref();
  const on = (e: StorageEvent) => e.key === KEY && applyAnimationPref();
  window.addEventListener("storage", on);
  return () => window.removeEventListener("storage", on);
}
