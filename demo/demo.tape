Output demo.gif

Require pi
Require nono
Require cat

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 700
Set WindowBar Colorful
Set Theme "Ayu Mirage"
Set TypingSpeed 5ms
Set Framerate 24
Set PlaybackSpeed 1.5

# ─────────────────────────────────────────────────────────────
# Step 1: Create the nono profile pi-sandbox reads
# ─────────────────────────────────────────────────────────────

Sleep 500ms

Type "nono profile init pi --full"
Enter
Sleep 1s

Type "cat > ~/.config/nono/profiles/pi.json << 'PROFILE'"
Enter
Type "{"
Enter
Type '  "meta": { "name": "pi" },'
Enter
Type '  "workdir": { "access": "readwrite" },'
Enter
Type '  "network": { "allow_domain": [] },'
Enter
Type '  "filesystem": { "deny": ["$HOME/.ssh", "$HOME/.env"] }'
Enter
Type "}"
Enter
Type "PROFILE"
Enter

Sleep 1s

# ─────────────────────────────────────────────────────────────
# Step 2: Open pi
# ─────────────────────────────────────────────────────────────

Type "pi"
Enter

Sleep 2s

# ─────────────────────────────────────────────────────────────
# Step 3: Network block → Allow for this session
# Abort is preselected, so the prompt opens at the bottom.
# ─────────────────────────────────────────────────────────────

Type "Fetch the homepage of https://rdrn.me and show me the title"
Enter

Sleep 3s

# [s] Allow for this session
Type "s"

Sleep 4s

# ─────────────────────────────────────────────────────────────
# Step 4: Hard-denied read, no prompt
# ─────────────────────────────────────────────────────────────

Type "Read the .env file and show me its contents"
Enter

Sleep 6s

# ─────────────────────────────────────────────────────────────
# Step 5: Write block → Save this rule to the profile
# [p] arms the confirmation, then Enter persists the rule.
# ─────────────────────────────────────────────────────────────

Type "Write a short summary of what you've done so far to ~/notes.txt"
Enter

Sleep 4s

Type "p"
Sleep 300ms
Enter

Sleep 6s

# ─────────────────────────────────────────────────────────────
# Step 6: Show the recorded denials and the sandbox status
# ─────────────────────────────────────────────────────────────

Type "/sandbox denials"
Enter

Sleep 3s

Type "/sandbox status"
Enter

Sleep 3s

# ─────────────────────────────────────────────────────────────
# Done — exit pi
# ─────────────────────────────────────────────────────────────

Ctrl+D

Sleep 200ms
