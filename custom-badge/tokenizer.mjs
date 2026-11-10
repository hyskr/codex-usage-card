import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';

const encoding = new Tiktoken(ranks);

export function countTokens(text) {
  return encoding.encode(text, [], []).length;
}
