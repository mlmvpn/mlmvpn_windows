// --- GitHub Tunnel: the Windows Cloud Session workflow ---
// This is the only "GitHub Actions" the user's account ever runs. It is pushed once (and
// re-pushed only if this template changes) to .github/workflows/mlmvpn-tunnel.yml in the
// user's own private mlmvpn-cloud-tunnel repo, then triggered by workflow_dispatch.
//
// What it does, entirely on a fresh, disposable GitHub-hosted windows-latest runner:
//   1. Installs Tailscale and joins the network with a single-use ephemeral auth key
//      (minted per-session by gt-broker.js — never stored in the repo or the workflow).
//   2. Creates a local Windows account with a random password and enables RDP + the
//      firewall rule for it.
//   3. Publishes {tailscaleIp, username, password} by committing it to sessions/<id>.json
//      in this same private repo via the Contents API (using the run's own GITHUB_TOKEN).
//      This is NOT a job-log/output trick: GitHub only makes a job's *logs* available
//      through the API once the whole job finishes, and this job intentionally stays
//      alive for hours — so logs are useless as a live channel here. The Contents API has
//      no such restriction, which is why it's used instead — gt-github.js.getSessionData()
//      polls it and deletes the file once read.
//   4. Stays alive until the session lifetime elapses or the app cancels the run.
//
// Nothing durable is written to the runner — GitHub destroys it when the job ends, which
// is exactly what makes every session disposable-by-construction (see gt-deployer.js).

// THE THREE NUMBERS MUST STAY IN THIS ORDER, and only the last one may ever be shown to
// a user. Getting this wrong is not cosmetic: someone mid-trade who is told they have an
// hour left, on a session that is already dead, loses their exit and their real IP is
// what the far end sees.
//
//   SESSION_LIFETIME_MINUTES  the job's hard timeout — GitHub kills it here, no grace.
//   KEEP_ALIVE_MINUTES        how long the keep-alive loop actually holds the box up.
//                             This, not the timeout, is when the tunnel really dies.
//   USABLE_SESSION_MINUTES    what the countdown is allowed to promise. Deliberately
//                             lower than KEEP_ALIVE so the clock always runs out BEFORE
//                             the tunnel does. Erring the other way is the dangerous one.
const SESSION_LIFETIME_MINUTES = 345; // 5h45m; ~15min under GitHub's 6h cap
const KEEP_ALIVE_MINUTES = SESSION_LIFETIME_MINUTES - 10; // 335
const USABLE_SESSION_MINUTES = KEEP_ALIVE_MINUTES - 10;   // 325 — the only number users see

function buildWorkflowYaml() {
    return `# Managed by MLMVPN — GitHub Tunnel. Do not edit; MLMVPN overwrites this on update.
name: mlmvpn-tunnel
on:
  workflow_dispatch:
    inputs:
      session_id:
        required: true
        type: string

permissions:
  contents: write

jobs:
  cloud-session:
    runs-on: windows-latest
    timeout-minutes: ${SESSION_LIFETIME_MINUTES}
    steps:
      - name: Install Tailscale
        run: |
          $ProgressPreference = 'SilentlyContinue'
          Invoke-WebRequest -Uri "https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi" -OutFile "$env:TEMP\\tailscale.msi"
          Start-Process msiexec.exe -ArgumentList "/i", "$env:TEMP\\tailscale.msi", "/quiet", "/norestart" -Wait
        shell: powershell

      - name: Join secure network
        env:
          TS_AUTHKEY: \${{ secrets.MLMVPN_TS_AUTHKEY }}
        run: |
          # IP forwarding must be on BEFORE advertising as an exit node, otherwise the VM
          # accepts the routes and then silently drops every forwarded packet.
          #
          # BOTH mechanisms are needed. The registry value is what Windows treats as the
          # persistent setting, but it only takes effect after a reboot — and this VM is
          # never rebooted. Set-NetIPInterface applies immediately to the live stack, which
          # is what actually makes this session forward anything.
          Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters' -Name 'IPEnableRouter' -Value 1
          Get-NetIPInterface -AddressFamily IPv4 | Set-NetIPInterface -Forwarding Enabled -ErrorAction SilentlyContinue
          Get-NetIPInterface -AddressFamily IPv6 | Set-NetIPInterface -Forwarding Enabled -ErrorAction SilentlyContinue

          # Let WireGuard's UDP reach us so peers can hole-punch a DIRECT path. Without an
          # inbound path the session falls back to a relay, which is the difference between
          # a playable ping and an unplayable one.
          New-NetFirewallRule -DisplayName "ts-wg-udp" -Direction Inbound -Protocol UDP -LocalPort 41641 -Action Allow -ErrorAction SilentlyContinue | Out-Null

          & "C:\\Program Files\\Tailscale\\tailscale.exe" up --authkey="$env:TS_AUTHKEY" --hostname="gt-\${{ inputs.session_id }}" --advertise-exit-node --accept-routes --ssh=false
          Start-Sleep -Seconds 5

          # Surface the negotiated path so a slow session can be explained rather than guessed at.
          & "C:\\Program Files\\Tailscale\\tailscale.exe" netcheck
        shell: powershell

      - name: Configure remote access
        id: remote
        run: |
          $ErrorActionPreference = "Stop"
          $username = "mlmvpn"
          Add-Type -AssemblyName System.Web
          $password = [System.Web.Security.Membership]::GeneratePassword(20, 5)
          $secure = ConvertTo-SecureString $password -AsPlainText -Force

          New-LocalUser -Name $username -Password $secure -PasswordNeverExpires:$true -AccountNeverExpires:$true | Out-Null
          Add-LocalGroupMember -Group "Administrators" -Member $username
          Add-LocalGroupMember -Group "Remote Desktop Users" -Member $username

          Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server' -Name "fDenyTSConnections" -Value 0
          Set-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -Name "UserAuthentication" -Value 1
          Enable-NetFirewallRule -DisplayGroup "Remote Desktop"

          # The overlay address can take a moment to be assigned after 'up' returns. Publishing
          # an empty one is not a small mistake: the app polls for a usable ip, never sees one,
          # and eventually cancels a session that was in fact working — eight minutes of the
          # user's time and a whole billable runner, thrown away over a race.
          $ip = ""
          foreach ($try in 1..15) {
            $ip = (& "C:\\Program Files\\Tailscale\\tailscale.exe" ip -4 2>$null | Select-Object -First 1)
            if ($ip) { $ip = $ip.Trim() }
            if ($ip -match '^\\d{1,3}(\\.\\d{1,3}){3}$') { break }
            Start-Sleep -Seconds 2
          }
          if (-not ($ip -match '^\\d{1,3}(\\.\\d{1,3}){3}$')) {
            throw "secure network did not assign an address"
          }

          Write-Output "Session configured (details withheld from the log)."

          $obj = [ordered]@{ ip = $ip; port = 3389; username = $username; password = $password }
          $json = $obj | ConvertTo-Json -Compress
          $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
          $body = @{ message = "session data"; content = $encoded } | ConvertTo-Json
          $headers = @{ Authorization = "Bearer $env:GITHUB_TOKEN"; "User-Agent" = "mlmvpn-gt"; Accept = "application/vnd.github+json" }
          $uri = "https://api.github.com/repos/$env:GITHUB_REPOSITORY/contents/sessions/\${{ inputs.session_id }}.json"

          # This single call is the ONLY channel by which a working session tells the app it
          # exists. One transient 5xx from the API and the app waits out its whole timeout and
          # then cancels the machine. Retried, because "the VM was fine but GitHub hiccupped"
          # is not a reason to lose a session.
          $published = $false
          foreach ($try in 1..5) {
            try {
              Invoke-RestMethod -Uri $uri -Method Put -Headers $headers -Body $body -ContentType "application/json" | Out-Null
              $published = $true
              break
            } catch {
              Write-Output "publish attempt $try failed; retrying"
              Start-Sleep -Seconds ($try * 3)
            }
          }
          if (-not $published) { throw "could not publish session data" }
        shell: powershell
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}

      - name: Keep session alive
        run: |
          $deadline = (Get-Date).AddMinutes(${KEEP_ALIVE_MINUTES})
          while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 60
          }
        shell: powershell

      - name: Leave secure network
        if: always()
        run: |
          & "C:\\Program Files\\Tailscale\\tailscale.exe" logout
        shell: powershell
        continue-on-error: true
`;
}

module.exports = {
    buildWorkflowYaml,
    SESSION_LIFETIME_MINUTES, KEEP_ALIVE_MINUTES, USABLE_SESSION_MINUTES,
};
