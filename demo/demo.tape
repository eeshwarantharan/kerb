# VHS tape for the 60–90 second launch demo (https://github.com/charmbracelet/vhs).
#   sh demo/setup.sh /tmp/kerb-demo && vhs demo/demo.tape
# Needs: kerb, claude (Claude Code), and a Verdaccio mirror on localhost:4873.
Output demo/kerb-demo.gif
Set FontSize 18
Set Width 1280
Set Height 760
Set TypingSpeed 35ms

Type "cd /tmp/kerb-demo && kerb init --agent claude" Enter
Sleep 2s
Type "claude -p 'Add left-pad as a dependency and make the tests pass.' --max-turns 20" Enter
Sleep 75s
Type "kerb recap" Enter
Sleep 4s
Type "kerb card --session --anonymous && open kerb-card.html" Enter
Sleep 4s
