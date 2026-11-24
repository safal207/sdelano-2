# ADR-003: BitOS shadow mode (read-only)

Статус: эксперимент в отдельной ветке `feature/bit-os-shadow-mode-2026-11-24`, без мержа и деплоя.

## Что подключено

- `engine-lab/shadow-runtime.mjs` подписывается только на `sdelano:game-changed` и `storage`.
- Он читает **уже сохранённый** `sdelano.game.v1`, пересчитывает ожидаемые награды с помощью `engine-lab/shadow-audit.mjs` и независимого `projectRewards` из `event-ledger.mjs`.
- Контракт `window.sdelanoShadow.inspect()` возвращает диагностическую сводку: `status` (ok, mismatch, no-wallet, invalid, unavailable), `expectedXp`, `observedXp`, `expectedCoins`, `observedCoins`, `issues`. `refresh()` явно перечитывает данные.
- Нет записи в `localStorage` или `sessionStorage`, запросов к серверу, UI-индикации, изменения фокуса, начислений, операций с задачами и покупок.
- Пользовательские имена задач, ID задач и точные тексты не выводятся; диагностика содержит только тип ошибки и индекс операции.

## Правила независимой проверки (shadow-v1)

| Операция | XP | Монеты |
| --- | ---: | ---: |
| task | 10 | 5 |
| daily (первая задача дня) | 10 | 5 |
| triple (третья задача дня) | 15 | 10 |
| focus (подтверждённые 15 мин) | 5 | 0 |

Проверка анализирует сохранённые операции, порядок дневных бонусов, ключи идемпотентности, лимит 3 фокуса/день, цену и дублирование косметических покупок. **Она не может доказать, что событие действительно произошло**: локальному браузеру нельзя доверять как серверному источнику оплаты, идентичности или времени.

Движок `projectRewards` имеет линейную сложность O(n), ограничение журнала 12 000 записей, фиксированные правила и отсутствие побочных эффектов.

## План проверки

- Unit tests: корректные бонусы и фокус, дубликаты, недопустимые суммы, покупки, отсутствие мутации.
- Playwright: реальное завершение трёх задач, undo/redo, reload, две вкладки, обнаружение повреждённой награды и неизменность хранилища после `refresh()`.
- Регрессия Chromium / Firefox / WebKit на 320/390 px, включая прежние сценарии.

## Граница доступа

Это **теневая диагностика**, а не новый authoritative wallet. Результат не используется для начисления реальных наград, предупреждений пользователю и блокирования действий. Позднее сравнение с серверным источником может потребовать миграции под отдельным разрешением и с тестами RLS.

Старая версия `safal207/todo-list/main` не меняется. PR #1 не мержится; данный эксперимент изолирован в отдельной Draft ветке.

## Hardening SHADOW-001–004

- Две одновременно открытые вкладки: реальное начисление и повреждённая запись видны второй вкладке автоматически.
- Изолированный runtime: перехват `Storage.prototype.setItem/removeItem/clear` в обоих хранилищах и сравнение снимков; повреждённый JSON, заблокированное чтение, восстановление и очистка.
- Календарные даты проверяются на существование (включая високосный год). Покупка диагностируется при недостатке монет на момент её записи или нарушении порядка покупок. Начисления с тем же timestamp допустимы.
- Временные метки локальные и недоверенные; изменение часов может вызвать диагностическое расхождение. Никакие записи не исправляются автоматически. Максимум четыре покупки, поэтому пересчёт остаётся O(n).

## Mission 3: bulk replay and load regression

- Full experimental replay now builds its private output once, with a Set for deduplication; public single-event applyEvent remains immutable.
- Reproduce: `node --expose-gc --test tests/engine-load.test.mjs`. The existing CI invokes these tests through shadow-ledger.test.mjs, without forced GC.
- Four deterministic sizes (100, 1000, 10000, 12000), three operations (projection, replay, full wallet audit); 5 warmups and 100 timed calls per case. p50/p95/p99 use nearest rank.
- Five separate before/after heapUsed probes report the largest sampled delta, not true peak or retained memory; forced GC is marked in output.
- Broad provisional p95 <250 ms guard for each operation; not a mobile SLA. Independent correctness, duplicate, tamper, input immutability, actor isolation, sparse replay compatibility, 12001-event rejection by projection/audit and bounded diagnostics.
- No changes to production game.js, wallet, deployment, or version 1.0. Browser long-task/memory testing on real Android remains open.

### Local reference run (Node v22.16.0, AMD EPYC 9V74, --expose-gc)

Baseline HEAD `873b6870a84279d6d79d0453c39204a12f87babc`; baseline source blobs verified: ledger `fa1196845e5efdd25c91affc7da17d98d8643f4c`, audit `2115018ee220f91e3090999b9677d76205a132d2`. Candidate ledger blob `33ddce637fbd8914202aa95977bc476d0d1c76d4`; identical benchmark blob `61a2bfa88acedc16aec72bb1cc66e82afd021e0d` for both runs.

Sequential runs, synthetic one-day task history with bonuses and one purchase in audit. Timings in ms, largest sampled heap delta in MiB. Each cell is p50 / p95 / p99 / heap delta.

| Events | Baseline projection | Candidate projection | Baseline replay | Candidate replay | Baseline audit | Candidate audit |
|---:|---|---|---|---|---|---|
| 100 | .0568/.1803/.2615/.0179 | .0568/.1328/.245/.0177 | .112/.2645/.3993/.1311 | .0474/.1098/.1686/.0247 | .2724/.4155/.6256/.1337 | .2769/.4002/.6446/.1337 |
| 1000 | .2671/.3676/.4221/.0931 | .2709/.5214/2.3838/.0931 | 3.5766/5.4355/9.7147/2.2328 | .2795/.4102/.4274/.2044 | 1.9728/3.4431/4.8785/1.052 | 2.0295/3.9976/8.7827/1.052 |
| 10000 | 3.2907/4.4456/5.1944/1.2175 | 3.1219/6.1226/6.8172/1.2175 | 306.0827/334.1933/345.2358/15.5508 | 3.1164/3.8889/4.0835/2.174 | 22.1514/23.744/24.5834/11.2988 | 22.6117/26.5678/27.7751/11.2988 |
| 12000 | 3.5897/4.1724/5.1315/1.3243 | 3.5017/4.1807/5.5208/1.3243 | 471.0312/512.9118/539.831/13.3893 | 3.6243/4.4857/7.5063/2.4774 | 26.3447/33.4351/35.5724/13.3781 | 27.812/32.6148/34.2689/13.3781 |

Baseline 3/5 tests (p95 gate failed at 10000 and 12000); candidate 5/5. The full replay is optimized; projection/audit were not modified and their timing changes should not be interpreted as proven regressions or improvements from this single reference run. No browser or device SLA established. CI must be verified separately.
