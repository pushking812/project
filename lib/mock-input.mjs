// doTool asks the person through `ctx.input`. Here nobody is at a keyboard, so this input answers by rule.
// Nothing that was not allowed up front goes ahead: running a command that touches a secret, opening a
// browser or a site all get "no". Only a file change is allowed (and those are not asked in modes all / edits).
const ALLOW = /Allow this change|Разрешить это изменение/i;

/** @returns {object} an input object shaped like ask-code's Input, enough for doTool */
export function createMockInput() {
  return {
    ask: async (question = '') => (ALLOW.test(String(question)) ? 'y' : 'n'),
    notes: [],
    lines: [],
    running: false,
    terminal: false,
    onInterrupt: null,
    close() {},
  };
}
