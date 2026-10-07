// core/shell.ts — builds copyable command lines from argument lists
//
// A provider's cli hook returns each command as an argument list
// (ProviderCommand); renderCommands turns the lists into command lines. Plan
// values in the arguments (tags, names, regions) are untrusted. Each argument
// is quoted so that POSIX sh, bash and zsh pass it to the program unchanged:
// no parameter or command substitution, globbing, word splitting or
// redirection. tools/test.js runs generated commands through all three.
// Other shells (fish, PowerShell, cmd.exe) use different quoting rules and
// are not covered.
import { CliCommand, ProviderCommand } from "../types/index.js";

/* Arguments that need no quoting in POSIX sh, bash or zsh. A leading "=" is
   excluded because zsh expands it. */
var UNQUOTED_SAFE = /^[A-Za-z0-9_@%+:,.\/-][A-Za-z0-9_@%+=:,.\/-]*$/;
/* Characters that keep a special meaning inside double quotes in bash or zsh;
   double quotes are used only for arguments without them. */
var SPECIAL_IN_DOUBLE_QUOTES = /[$`"\\!]/;
/* Control characters, newline included. A newline ends the command line, so
   the text after it would run as a separate command. */
var CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function shellQuote(arg: string): string {
  /* Every other argument is quoted, including placeholders such as
     "<vpc-id>": unquoted, "<input> output" is read as two redirections. */
  if (UNQUOTED_SAFE.test(arg)) return arg;
  if (arg.indexOf("'") < 0) return "'" + arg + "'";
  if (!SPECIAL_IN_DOUBLE_QUOTES.test(arg)) return '"' + arg + '"';
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/* The command line, or null if any argument is not a non-empty string or
   contains a control character. renderCommands omits commands that return
   null. */
export function commandLine(argv: unknown): string | null {
  if (!Array.isArray(argv) || !argv.length) return null;
  var parts: string[] = [];
  for (var i = 0; i < argv.length; i++){
    var a = argv[i];
    if (typeof a !== "string" || !a || CONTROL_CHARS.test(a)) return null;
    parts.push(shellQuote(a));
  }
  return parts.join(" ");
}

export function renderCommands(cmds: ProviderCommand[] | null | undefined): CliCommand[] {
  var out: CliCommand[] = [];
  (cmds || []).forEach(function(c: ProviderCommand){
    var line = c && typeof c.label === "string" ? commandLine(c.argv) : null;
    if (line) out.push({label: c.label, cmd: line});
  });
  return out;
}
