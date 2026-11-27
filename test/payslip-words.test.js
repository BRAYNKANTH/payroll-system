// The payslip writes the salary in words and has lines for the authority's and the employee's signature.
const test = require("node:test");
const assert = require("node:assert/strict");
const { amountInWords } = require("../reports");

test("an amount in cents is written out in words", () => {
  assert.equal(amountInWords(0), "Rupees Zero Only");
  assert.equal(amountInWords(2090890), "Rupees Twenty Thousand Nine Hundred and Eight and Ninety Cents Only");
  assert.equal(amountInWords(1250000), "Rupees Twelve Thousand Five Hundred Only");
  assert.equal(amountInWords(1000100), "Rupees Ten Thousand and One Only");
  assert.equal(amountInWords(101), "Rupees One and One Cent Only");
  assert.equal(amountInWords(12345678900), "Rupees One Hundred and Twenty-Three Million Four Hundred and Fifty-Six Thousand Seven Hundred and Eighty-Nine Only");
  assert.equal(amountInWords(-4235000), "Minus Rupees Forty-Two Thousand Three Hundred and Fifty Only");
});
