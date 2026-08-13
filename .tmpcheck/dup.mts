import { FIELD_SEED } from '../services/chats/prisma/seed.fields';
const names = FIELD_SEED.optionSets.map((s) => s.name);
console.log('dup set names:', names.filter((n, i) => names.indexOf(n) !== i));
const labels = FIELD_SEED.fieldDefinitions.map((f) => f.label);
console.log('dup field labels:', labels.filter((n, i) => labels.indexOf(n) !== i));
const fn = FIELD_SEED.forms.map((f) => f.name);
console.log('dup form names:', fn.filter((n, i) => fn.indexOf(n) !== i));
