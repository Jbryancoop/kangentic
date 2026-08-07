## What's New

- **Mobile companion app, out of dev builds** - the mobile bridge now ships in production, so you can pair a phone from Settings > Mobile Devices on a normal install. The relay picker names the hosted relay and backs its "Official" badge with a published page you can check, the pairing steps link to the full docs, and a fresh install gets a "Pair a phone" link on the welcome screen.
- **In-app announcements** - product announcements now arrive inside Kangentic instead of only on the website, with a "Get the App" section in Mobile Devices.
- **Agent Crash notifications in Settings** - the Agent Crash notification finally has a control in the Notifications tab. It was previously reachable only by hand-editing config.
- **Self-repairing terminal frames** - a terminal session that reopens with missing rows now detects it, repairs the replay, and captures what went wrong.

## Bug Fixes

- Activity indicators no longer stutter or freeze while Kangentic is busy. Their motion moved to a composited property, so the spinning rings and the blinking terminal prompt keep animating through main-thread work that used to stall them for hundreds of milliseconds at a time.
- Terminal width no longer drifts out of sync between the PTY and the grid you see.
- Opening an attachment with no default application now tells you what happened and reveals the file in your file manager, instead of appearing to do nothing.
- The relay mode picker in Mobile Devices no longer renders blank in production when an earlier "local" setting was saved.
- Reopening a fullscreen terminal no longer triggers a spurious repaint from xterm's own reports.

## Breaking Changes

- **Mobile pairing changed on the wire** (`@kangentic/protocol` 0.12.0). The pairing relay slot is now derived from the pairing token rather than being the token, so the token no longer travels in cleartext as a query parameter, and a device is authenticated before its pairing token is consumed, so an unauthenticated frame can no longer burn a pairing ceremony. All peers must be on the new protocol version, and every already-paired device must re-pair.
