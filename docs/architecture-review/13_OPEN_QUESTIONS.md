# 13. Open Questions

Questions the reviewer could not answer from the repository. Owner = who can answer.

## Business and statutory (owner / accountant)

1. What is the business's aggregate turnover, and is e-invoicing or e-way billing already mandatory for it? (Not modelled; determines G-016.)
2. Is the 16-character invoice-number limit applicable, and what numbering format does the accountant want? (G-GST-02)
3. Which taxes apply to the actual goods: rates, HSN digit length, any cess, composition or reverse-charge cases? (G-002, G-017)
4. Are services, freight or packing charges billed? (G-013)
5. Are exports, SEZ or inter-state B2C sales part of the business? (Unsupported today.)
6. What is the correction policy: credit notes only, or cancellation within a window? (G-001)
7. Is back-dating ever needed, and under what controls? (G-012)
8. Required reports: GSTR-1 data, sales register, ageing, stock valuation? (G-009)

## Operations (owner)

9. How many users, which roles, and is remote access planned for a second user or the auditor? (Hosting is deferred.)
10. Where will backups be copied, and who owns the passphrase? (G-003)
11. Which printer and paper (A4, thermal) will be used? (R-093)
12. Expected monthly invoice and stock-line volumes? (G-024)
13. Is a single warehouse enough?

## Technical (maintainer)

14. Which PostgreSQL version is intended for production, given the embedded runtime is 18 beta? (G-022)
15. Is the Electron advisory exploitable in this configuration, and what is the patched version? (S-01)
16. When will a code-signing certificate be obtained? (G-005)
17. Should the four README-only packages be removed or built? (G-023)
18. Is the intended order of work MTO-2 first, or corrections first? (Reviewer recommends corrections.)
19. Why do `customers.credit_limit` and `payment_terms_days` exist if unused: planned enforcement?
20. Should audit logs be exportable to an external reviewer, and for how long retained?

## Privacy

21. Is customer data subject to the DPDP Act obligations (consent, deletion, retention) in the owner's situation?
22. Should backups containing customer data be allowed on removable media, and who is accountable?
