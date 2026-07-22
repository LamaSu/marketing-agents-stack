/**
 * render.ts — a tiny, deterministic `{{var}}` template substitution used to turn a step's
 * `subjectTemplate` / `bodyTemplate` into concrete `Draft` subject/body at queue time.
 *
 * Deliberately minimal (no partials, no logic, no eval): the rendered text becomes a PENDING
 * draft a human reviews before anything is sent, so an unresolved `{{token}}` is left visible
 * on purpose — it surfaces a missing variable to the human reviewer rather than silently
 * shipping a blank. Pure and synchronous; identical input always yields identical output.
 */

/**
 * Replace every `{{ key }}` occurrence in `template` with `vars[key]`. Unknown keys are left
 * untouched (the literal `{{key}}` stays), so a forgotten variable is obvious in the pending
 * draft rather than rendered as an empty string.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match: string, key: string) => {
    const value = vars[key];
    return value === undefined ? match : value;
  });
}
