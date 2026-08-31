STAFF MONITOR v1.4 INSTALLATION

1. Deploy the v1.4 backend to Railway first.
2. Extract this ZIP on the company PC.
3. Double-click install\StaffMonitorSetup-v1.4.cmd.
4. Approve the Windows Administrator prompt.
5. Wait for INSTALLATION / UPDATE SUCCESSFUL.
6. Open the dashboard, select the PC, then click LIVE SCREEN.

This installer is intentionally a transparent administrator script instead of a self-installing unsigned bootstrap EXE. The previous bootstrap was quarantined by Microsoft Defender as Behavior:Win32/Persistence.A!ml. This package does NOT disable Defender, add exclusions, or attempt to evade endpoint protection.

For large enterprise deployment, code-sign the agent and distribute with Intune/GPO/RMM. Unsigned internal software can still receive reputation warnings depending on endpoint policy.
