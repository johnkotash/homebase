import { Platform } from "react-native";

/**
 * What only makes sense on a phone. The desktop window and the browser show the same screens as the
 * phone minus these; each one is hidden there, and its code never runs, so nothing can throw.
 * Add to this list instead of scattering `Platform.OS` checks through the screens.
 */

/** True in the Android (or iOS) build. False in the desktop window and in a browser. */
export const isPhoneApp = Platform.OS !== "web";

export const features = {
  /**
   * Driving mode: a full-screen, hands-free queue that keeps the screen awake and listens for spoken
   * commands. It needs the phone's speech recognizer and wake lock, and nobody drives a desktop.
   */
  drivingMode: isPhoneApp,
} as const;
