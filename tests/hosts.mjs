// SPDX-License-Identifier: MIT OR Apache-2.0
// Whether source text names a host: with a scheme (https://h, wss://h), or without one (//h, as in fetch('//h/x') or '' + '//h').
// A comment's own slashes do not count (they are followed by a space), nor do the slashes of an escaped regex or of a scheme.
export const SCHEMELESS = /(?<![:\w/\\])\/\/[a-z0-9][\w.-]*/i;
export const namesHost = (text) => /\b(?:https?|wss?):\/\/[^\s'"`)]+/.test(text) || SCHEMELESS.test(text);
