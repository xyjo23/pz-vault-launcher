# Changelog

## 0.6.1-preview - 2026-11-10

- Fixed legacy frozen versions disappearing when `freeze.json` contains a UTF-8 BOM.
- Unified Steam original and frozen versions under one current-version state.
- Added user-defined version names as the primary title throughout the application.
- Added compact and full relative version radars with hover details and double-click switching.
- Added current-version Mods, Saves, backup and log shortcuts to the console.
- Renamed Environment Details and Summary to Version Details and Summary.

## 0.6.0-preview - 2026-11-10

- Added native Steam AppID 108600 discovery.
- Added safe full-copy migration from Steam or frozen sources.
- Added experimental hard-link reuse for frozen sources with copy fallback.
- Added SHA-256 manifests, native launch and integrity verification.
- Added first-run save-snapshot guidance and pre-migration mutable-data backups.
- Rebuilt the desktop interface around Console, Version Management, Maintenance, Help and Settings.
