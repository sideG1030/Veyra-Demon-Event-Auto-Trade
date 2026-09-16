// ==UserScript==
// @name         Veyra Demon Event Auto Trade
// @namespace    https://github.com/sideG1030
// @version      1.6.5
// @description  Automatic Veyra event trade planner/executor with mixed cargo, daily planning, recovery, and restock handling.
// @homepageURL  https://github.com/sideG1030/Veyra-Demon-Event-Auto-Trade
// @updateURL    https://raw.githubusercontent.com/sideG1030/Veyra-Demon-Event-Auto-Trade/main/veyra-demon-event-auto-trade.user.js
// @downloadURL  https://raw.githubusercontent.com/sideG1030/Veyra-Demon-Event-Auto-Trade/main/veyra-demon-event-auto-trade.user.js
// @match        https://demonicscans.org/event_page.php*
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    /******************************************************************
     * Veyra Auto Trader
     *
     * MODES
     *
     * 1. PLANNED
     *    - Scans all four markets.
     *    - Calculates a route for the remaining time before 00:00.
     *    - Can use guarded or risky routes.
     *    - Accounts for:
     *        prices
     *        stock
     *        demand
     *        weight
     *        mixed cargo
     *        distance
     *        transport speed
     *        rent
     *        tolls
     *        expected bandit losses
     *        end-of-day city
     *    - Uses a next-day lookahead to avoid ending the day somewhere
     *      terrible just because today's immediate profit is high.
     *
     * 2. IMMEDIATE
     *    - Safe / guarded routes only.
     *    - Does NOT plan future routes.
     *    - Re-scans markets and takes the immediately best guarded trade.
     *    - Time is included via silver/hour.
     *
     ******************************************************************/

    const SCRIPT_VERSION = '1.6.5';

    const STORAGE_KEY = 'veyra_auto_trader_v1';

    const CITIES = [
        'Lastlight Fort',
        'Nocthar, the Oathbound City',
        'Ashkar, the Furnace City',
        'Velmora, the Chainmarket'
    ];

    const SHORT_CITY = {
        'Lastlight Fort': 'Lastlight',
        'Nocthar, the Oathbound City': 'Nocthar',
        'Ashkar, the Furnace City': 'Ashkar',
        'Velmora, the Chainmarket': 'Velmora'
    };

    const RESOURCES = [
        'Demonic Salt',
        'Ashgrain',
        'Blood-Iron Ingots',
        'Blacksteel Tools',
        'Hellroot Resin',
        'Obsidian Silk',
        'Ember Spice',
        'Nightglass',
        'Soulwax',
        'Oathstone'
    ];

    const ROUTES = {
        'Lastlight Fort': {
            'Nocthar, the Oathbound City': { guarded: 10000, risky: 8000 },
            'Ashkar, the Furnace City': { guarded: 12000, risky: 9600 },
            'Velmora, the Chainmarket': { guarded: 9000, risky: 7200 }
        },

        'Nocthar, the Oathbound City': {
            'Lastlight Fort': { guarded: 10000, risky: 8000 },
            'Ashkar, the Furnace City': { guarded: 8500, risky: 6800 },
            'Velmora, the Chainmarket': { guarded: 11000, risky: 8800 }
        },

        'Ashkar, the Furnace City': {
            'Lastlight Fort': { guarded: 12000, risky: 9600 },
            'Nocthar, the Oathbound City': { guarded: 8500, risky: 6800 },
            'Velmora, the Chainmarket': { guarded: 7000, risky: 5600 }
        },

        'Velmora, the Chainmarket': {
            'Lastlight Fort': { guarded: 9000, risky: 7200 },
            'Nocthar, the Oathbound City': { guarded: 11000, risky: 8800 },
            'Ashkar, the Furnace City': { guarded: 7000, risky: 5600 }
        }
    };

    const TRANSPORTS = {
        walk: {
            id: 'walk',
            name: 'Walking',
            speed: 60,
            capacity: 500,
            rent: 0
        },

        horse: {
            id: 'rent:1',
            name: 'Lastlight Warhorse',
            speed: 240,
            capacity: 750,
            rent: 35
        },

        buffalo: {
            id: 'rent:2',
            name: 'Ironhide Buffalo',
            speed: 90,
            capacity: 2000,
            rent: 60
        }
    };

    const CONFIG = {
        beamWidth: 75,
        maxPlanDepth: 32,
        nextDayLookaheadMinutes: 360,
        fullRestockAmount: 2000,
        banditLossFraction: 0.10,
        actionDelay: 500,
        lateArrivalReplanMinutes: 10,
        tickInterval: 5000,

        /*
         * Planned-mode transport policy:
         * Buffalo = bulk trading from a good city.
         * Warhorse = fast repositioning when the destination has materially
         * better future Buffalo opportunities.
         */
        repositionHubImprovement: 1.12,
        buffaloFullWeightFraction: 0.98
    };

    function defaultState() {
        return {
            running: false,
            mode: 'planned',
            minimized: false,
            banditProbability: 0.30,
            plan: null,
            nextStepIndex: 0,
            inTransitStepIndex: null,
            expectedArrivalReal: null,
            departureGameSeconds: null,
            expectedArrivalGameSeconds: null,
            planValidUntilReal: null,
            needsRecalcAtArrival: false,
            manualJourneyDestination: null,
            arrivalBaseline: null,
            lastGameSeconds: null,
            gameClockOffsetSeconds: null,
            gameClockSyncedAt: null,
            dashboardClockEpoch: null,
            dashboardClockTzOffset: null,
            dashboardClockFetchedAt: null,
            status: 'Stopped',
            lastScan: null,
            caravanCity: null,
            lastError: null
        };
    }

    function loadState() {
        let saved = {};
        try {
            saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        } catch (_) {}

        return {
            ...defaultState(),
            ...saved
        };
    }

    function saveState(state) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderPanel();
    }

    function patchState(patch) {
        const state = loadState();
        Object.assign(state, patch);
        saveState(state);
        return state;
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function normalize(text) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function formatNumber(n, digits = 0) {
        return Number(n || 0).toLocaleString(undefined, {
            maximumFractionDigits: digits
        });
    }

    function formatMinutes(minutes) {
        if (!Number.isFinite(minutes)) return '—';

        const totalSeconds = Math.max(0, Math.round(minutes * 60));
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;

        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    function log(...args) {
        console.log('[Veyra Auto Trader]', ...args);
    }

    function errorLog(...args) {
        console.error('[Veyra Auto Trader]', ...args);
    }

    function setStatus(text) {
        patchState({ status: text });
    }

    async function waitFor(test, timeout = 10000, interval = 100) {
        const start = Date.now();

        while (Date.now() - start < timeout) {
            try {
                const result = test();
                if (result) return result;
            } catch (_) {}

            await sleep(interval);
        }

        return null;
    }

    async function waitForBodyMutation(timeout = 10000) {
        const target = document.querySelector('#ecDialogBody');

        if (!target) {
            await sleep(CONFIG.actionDelay);
            return;
        }

        return new Promise(resolve => {
            let resolved = false;

            const observer = new MutationObserver(() => {
                if (resolved) return;

                resolved = true;
                observer.disconnect();

                setTimeout(resolve, CONFIG.actionDelay);
            });

            observer.observe(target, {
                childList: true,
                subtree: true,
                characterData: true
            });

            setTimeout(() => {
                if (resolved) return;

                resolved = true;
                observer.disconnect();
                resolve();
            }, timeout);
        });
    }

    function setInputValue(input, value) {
        if (!input) return false;

        const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value'
        )?.set;

        if (setter) {
            setter.call(input, String(value));
        } else {
            input.value = String(value);
        }

        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        return true;
    }

    function tradingPostIsOpen() {
        const title = document.querySelector('#ecDialogTitle');
        const dialog = document.querySelector('#ecDialog');

        return (
            dialog &&
            dialog.hasAttribute('open') &&
            normalize(title?.textContent) === 'Trading Post'
        );
    }

    async function ensureTradingPostOpen() {
        if (tradingPostIsOpen()) return true;

        const marker = document.querySelector(
            'button.ec-marker[data-kind="section"][data-key="trade"]'
        );

        if (!marker) return false;

        marker.click();

        return Boolean(await waitFor(() => tradingPostIsOpen(), 10000));
    }

    function getPanelNote() {
        return normalize(
            document.querySelector('#ecDialogBody .ec-panel-note')?.textContent
        );
    }

    function parseCityFromPanelNote() {
        const note = getPanelNote();
        if (!note) return null;

        for (const city of CITIES) {
            if (note.includes(city)) return city;
        }

        return null;
    }

    function getSilver() {
        const note = getPanelNote();
        const match = note.match(/([\d,]+)\s+Demonic Silver/i);

        if (!match) return null;

        return Number(match[1].replace(/,/g, ''));
    }

    function getMarketSelect() {
        return document.querySelector('.ec-market-picker select');
    }

    async function selectMarket(city) {
        let select = getMarketSelect();
        if (!select) return false;

        const option = [...select.options].find(
            o => normalize(o.textContent) === city
        );

        if (!option) return false;

        if (select.value === option.value && parseCityFromPanelNote() === city) {
            return true;
        }

        const mutation = waitForBodyMutation();

        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));

        await mutation;

        return Boolean(
            await waitFor(() => parseCityFromPanelNote() === city, 5000)
        );
    }


    async function forceRefreshMarket(city) {
        const select = getMarketSelect();

        if (!select) {
            return false;
        }

        const target = [...select.options].find(
            o => normalize(o.textContent) === city
        );

        if (!target) {
            return false;
        }

        /*
         * Selecting the already-selected market does not rebuild the DOM.
         * Temporarily switch to another market and back so the game
         * regenerates Cargo to load from the latest server-side storage.
         */
        const other = [...select.options].find(
            o => o.value !== target.value
        );

        if (other) {
            const mutation1 = waitForBodyMutation();

            select.value = other.value;
            select.dispatchEvent(
                new Event('change', { bubbles: true })
            );

            await mutation1;
        }

        const select2 = getMarketSelect();

        if (!select2) {
            return false;
        }

        const target2 = [...select2.options].find(
            o => normalize(o.textContent) === city
        );

        if (!target2) {
            return false;
        }

        const mutation2 = waitForBodyMutation();

        select2.value = target2.value;
        select2.dispatchEvent(
            new Event('change', { bubbles: true })
        );

        await mutation2;

        return Boolean(
            await waitFor(
                () =>
                    parseCityFromPanelNote() === city &&
                    /Caravan present/i.test(getPanelNote()),
                5000
            )
        );
    }


    async function ensureCaravanMarket(expectedCity = null) {
        /*
         * Always force a real market refresh. Merely setting the same select
         * value can leave the DOM on a stale "Prices only" view.
         */
        if (expectedCity) {
            await forceRefreshMarket(expectedCity);

            if (
                parseCityFromPanelNote() === expectedCity &&
                /Caravan present/i.test(getPanelNote())
            ) {
                patchState({
                    caravanCity: expectedCity
                });

                return expectedCity;
            }
        }

        /*
         * If the expected/cached city was wrong, actively scan every market
         * until the one showing "Caravan present" is found.
         */
        const select = getMarketSelect();

        if (!select) {
            return null;
        }

        for (const city of CITIES) {
            await forceRefreshMarket(city);

            if (
                parseCityFromPanelNote() === city &&
                /Caravan present/i.test(getPanelNote())
            ) {
                patchState({
                    caravanCity: city
                });

                return city;
            }
        }

        return null;
    }

    function findResourceCard(resource) {
        return [
            ...document.querySelectorAll('#ecDialogBody article.ec-card')
        ].find(card => {
            const h3 = normalize(card.querySelector('h3')?.textContent);
            return h3 === resource;
        }) || null;
    }

    function parseResourceCard(resource) {
        const card = findResourceCard(resource);
        if (!card) return null;

        const content = card.querySelector('.ec-card-content');
        const text = normalize(content?.textContent);

        const match = text.match(
            /Buy\s+(\d+)\s*\/\s*Sell\s+(\d+)\s+silver\s*\|\s*Weight\s+(\d+).*?Stored here:\s*(\d+).*?Stock remaining today:\s*(\d+)\s*\|\s*Demand:\s*(\d+)/i
        );

        if (!match) return null;

        return {
            resource,
            card,
            buy: Number(match[1]),
            sell: Number(match[2]),
            weight: Number(match[3]),
            stored: Number(match[4]),
            stock: Number(match[5]),
            demand: Number(match[6])
        };
    }

    function parseCurrentMarket() {
        const city = parseCityFromPanelNote();
        if (!city) return null;

        const resources = {};

        for (const resource of RESOURCES) {
            const data = parseResourceCard(resource);

            if (data) {
                resources[resource] = {
                    buy: data.buy,
                    sell: data.sell,
                    weight: data.weight,
                    stored: data.stored,
                    stock: data.stock,
                    demand: data.demand
                };
            }
        }

        return {
            city,
            silver: getSilver(),
            resources
        };
    }

    function getExpeditionCard() {
        const clock = document.querySelector('.ec-expedition-clock');
        return clock?.closest('article.ec-card') || null;
    }

    function getExpeditionDestination() {
        const card = getExpeditionCard();
        const title = normalize(card?.querySelector('h3')?.textContent);

        const match = title.match(/^En route to (.+)$/i);

        return match ? normalize(match[1]) : null;
    }

    function getCaravanState() {
        const note = getPanelNote();
        const clock = document.querySelector('.ec-expedition-clock');
        const state = loadState();

        /*
         * LIVE market state wins over an expedition clock. After the server
         * auto-resolves an arrival, Safari can leave the old expedition card
         * in the DOM briefly while the market note already says
         * "Caravan present".
         */
        if (/Caravan present/i.test(note)) {
            return {
                type: 'present',
                city: parseCityFromPanelNote()
            };
        }

        if (clock) {
            const text = normalize(clock.textContent);

            if (/ready to resolve/i.test(text)) {
                return {
                    type: 'arrived_ready',
                    destination: getExpeditionDestination(),
                    text
                };
            }

            return {
                type: 'travelling',
                destination: getExpeditionDestination(),
                text
            };
        }

        if (
            state.inTransitStepIndex !== null &&
            state.plan?.steps?.[state.inTransitStepIndex]
        ) {
            const step = state.plan.steps[state.inTransitStepIndex];

            if (
                hasReachedExpectedGameArrival(
                    state,
                    getGameClock().seconds
                )
            ) {
                return {
                    type: 'arrived_ready',
                    destination: step.to,
                    text: 'Expected game-time arrival has passed'
                };
            }

            return {
                type: 'travelling',
                destination: step.to,
                text: 'Travelling (cached ETA)'
            };
        }

        if (state.manualJourneyDestination) {
            return {
                type: 'travelling',
                destination: state.manualJourneyDestination,
                text: 'Travelling (manual journey cached)'
            };
        }

        if (state.caravanCity) {
            return {
                type: 'present',
                city: state.caravanCity,
                cached: true
            };
        }

        return {
            type: 'unknown'
        };
    }

    let serverClockAnchor = null;

    function getServerClockAnchor() {
        if (serverClockAnchor) {
            return serverClockAnchor;
        }

        const el = document.querySelector(
            '.ec-raid-clock [data-now]'
        );

        const epoch = Number(
            el?.getAttribute('data-now')
        );

        if (Number.isFinite(epoch) && epoch > 0) {
            serverClockAnchor = {
                epoch,
                localMs: Date.now()
            };

            return serverClockAnchor;
        }

        return null;
    }

    function parseClockText(text) {
        const match = String(text || '').match(
            /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/
        );

        if (!match) return null;

        const h = Number(match[1]);
        const m = Number(match[2]);
        const s = Number(match[3] || 0);

        return h * 3600 + m * 60 + s;
    }

    async function syncGameClockFromDashboard() {
        try {
            const response = await fetch(
                '/game_dash.php',
                {
                    method: 'GET',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: {
                        'Accept': 'text/html'
                    }
                }
            );

            if (!response.ok) {
                throw new Error(
                    `game_dash.php returned HTTP ${response.status}`
                );
            }

            const html = await response.text();

            const doc = new DOMParser()
                .parseFromString(
                    html,
                    'text/html'
                );

            const el =
                doc.querySelector('#server_time');

            if (!el) {
                throw new Error(
                    'Could not find #server_time on game_dash.php'
                );
            }

            const epoch =
                Number(
                    el.getAttribute(
                        'data-epoch'
                    )
                );

            const tzOffset =
                Number(
                    el.getAttribute(
                        'data-tzoff'
                    )
                );

            if (
                !Number.isFinite(epoch) ||
                !Number.isFinite(tzOffset)
            ) {
                throw new Error(
                    'Invalid server time attributes on game_dash.php'
                );
            }

            const state = loadState();

            state.dashboardClockEpoch =
                epoch;

            state.dashboardClockTzOffset =
                tzOffset;

            state.dashboardClockFetchedAt =
                Date.now();

            /*
             * Remove any old manual-sync value so it cannot override the
             * authoritative dashboard clock.
             */
            state.gameClockOffsetSeconds =
                null;

            state.gameClockSyncedAt =
                null;

            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(state)
            );

            return true;

        } catch (error) {
            errorLog(
                'Could not refresh game clock from dashboard:',
                error
            );

            return false;
        }
    }

    function getGameClock() {
        const state = loadState();

        /*
         * Authoritative source:
         * /game_dash.php exposes:
         *
         *   #server_time
         *   data-epoch="..."
         *   data-tzoff="..."
         *
         * The dashboard itself renders server-local time by adding the
         * timezone offset to the epoch and then reading UTC fields.
         */
        if (
            Number.isFinite(
                state.dashboardClockEpoch
            ) &&
            Number.isFinite(
                state.dashboardClockTzOffset
            ) &&
            Number.isFinite(
                state.dashboardClockFetchedAt
            )
        ) {
            const elapsedSeconds =
                (
                    Date.now() -
                    state.dashboardClockFetchedAt
                ) / 1000;

            const serverEpochNow =
                state.dashboardClockEpoch +
                elapsedSeconds;

            const shifted =
                new Date(
                    (
                        serverEpochNow +
                        state.dashboardClockTzOffset
                    ) * 1000
                );

            return {
                seconds:
                    shifted.getUTCHours() *
                        3600 +
                    shifted.getUTCMinutes() *
                        60 +
                    shifted.getUTCSeconds(),

                source:
                    'game dashboard'
            };
        }

        /*
         * If this page itself ever contains the dashboard server clock,
         * use it directly.
         */
        const el =
            document.querySelector(
                '#server_time[data-epoch][data-tzoff]'
            );

        if (el) {
            const epoch =
                Number(
                    el.getAttribute(
                        'data-epoch'
                    )
                );

            const tzOffset =
                Number(
                    el.getAttribute(
                        'data-tzoff'
                    )
                );

            if (
                Number.isFinite(epoch) &&
                Number.isFinite(tzOffset)
            ) {
                const shifted =
                    new Date(
                        (
                            epoch +
                            tzOffset
                        ) * 1000
                    );

                return {
                    seconds:
                        shifted.getUTCHours() *
                            3600 +
                        shifted.getUTCMinutes() *
                            60 +
                        shifted.getUTCSeconds(),

                    source:
                        'page game clock'
                };
            }
        }

        /*
         * Last-resort fallback only. Normally startup refreshes the dashboard
         * before any plan is calculated.
         */
        const now = new Date();

        return {
            seconds:
                now.getHours() * 3600 +
                now.getMinutes() * 60 +
                now.getSeconds(),

            source:
                'local fallback'
        };
    }

    function formatLocalClock() {
        const now = new Date();

        return [
            now.getHours(),
            now.getMinutes(),
            now.getSeconds()
        ]
            .map(x => String(x).padStart(2, '0'))
            .join(':');
    }

    function secondsUntilReset() {
        const clock = getGameClock();
        const remaining = 86400 - clock.seconds;

        return remaining <= 0 ? 86400 : remaining;
    }


    function gameSecondsElapsed(fromSeconds, toSeconds) {
        if (
            !Number.isFinite(fromSeconds) ||
            !Number.isFinite(toSeconds)
        ) {
            return null;
        }

        return (
            toSeconds -
            fromSeconds +
            86400
        ) % 86400;
    }

    function hasReachedExpectedGameArrival(state, currentGameSeconds) {
        if (
            !Number.isFinite(state.departureGameSeconds) ||
            !Number.isFinite(state.expectedArrivalGameSeconds) ||
            !Number.isFinite(currentGameSeconds)
        ) {
            /*
             * Backward compatibility for journeys created by older script
             * versions.
             */
            return Boolean(
                state.expectedArrivalReal &&
                Date.now() >= state.expectedArrivalReal
            );
        }

        const required =
            gameSecondsElapsed(
                state.departureGameSeconds,
                state.expectedArrivalGameSeconds
            );

        const elapsed =
            gameSecondsElapsed(
                state.departureGameSeconds,
                currentGameSeconds
            );

        return (
            Number.isFinite(required) &&
            Number.isFinite(elapsed) &&
            elapsed >= required
        );
    }

    function gameTimeUntilExpectedArrival(state, currentGameSeconds) {
        if (
            !Number.isFinite(state.expectedArrivalGameSeconds) ||
            !Number.isFinite(currentGameSeconds)
        ) {
            return null;
        }

        return (
            state.expectedArrivalGameSeconds -
            currentGameSeconds +
            86400
        ) % 86400;
    }

    function formatGameClock() {
        const { seconds } = getGameClock();

        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);

        return [h, m, s]
            .map(x => String(x).padStart(2, '0'))
            .join(':');
    }

    let scannerBusy = false;

    async function scanAllMarkets() {
        if (scannerBusy) {
            throw new Error('Market scanner is already running.');
        }

        scannerBusy = true;

        try {
            setStatus('Scanning all markets...');

            if (!await ensureTradingPostOpen()) {
                throw new Error('Could not open Trading Post.');
            }

            const priorState = loadState();

            const restoreCity =
                parseCityFromPanelNote() ||
                priorState.caravanCity;

            const markets = {};
            let foundCaravanCity = null;

            for (const city of CITIES) {
                setStatus(`Scanning ${SHORT_CITY[city]}...`);

                const ok = await selectMarket(city);

                if (!ok) {
                    throw new Error(`Could not view market: ${city}`);
                }

                const parsed = parseCurrentMarket();

                if (!parsed) {
                    throw new Error(`Could not parse market: ${city}`);
                }

                markets[city] = parsed.resources;

                if (/Caravan present/i.test(getPanelNote())) {
                    foundCaravanCity = city;

                    const interim = loadState();
                    interim.caravanCity = city;

                    localStorage.setItem(
                        STORAGE_KEY,
                        JSON.stringify(interim)
                    );
                }
            }

            /*
             * Restore the ACTUAL caravan city after scanning. This guarantees
             * Buy/Sell controls are present for the next action.
             */
            const cityToRestore =
                foundCaravanCity ||
                priorState.caravanCity ||
                restoreCity;

            if (cityToRestore) {
                await selectMarket(cityToRestore);
            }

            patchState({
                caravanCity:
                    foundCaravanCity ||
                    priorState.caravanCity ||
                    null,

                lastScan: {
                    time: Date.now(),
                    markets
                }
            });

            return markets;

        } finally {
            scannerBusy = false;
        }
    }

    function createLimits(markets) {
        const stock = {};
        const demand = {};

        for (const city of CITIES) {
            stock[city] = {};
            demand[city] = {};

            for (const resource of RESOURCES) {
                stock[city][resource] =
                    markets[city]?.[resource]?.stock ?? 0;

                demand[city][resource] =
                    markets[city]?.[resource]?.demand ?? 0;
            }
        }

        return { stock, demand };
    }

    function createFreshLimits(markets) {
        const stock = {};
        const demand = {};

        for (const city of CITIES) {
            stock[city] = {};
            demand[city] = {};

            for (const resource of RESOURCES) {
                if (markets[city]?.[resource]) {
                    stock[city][resource] = CONFIG.fullRestockAmount;
                    demand[city][resource] = CONFIG.fullRestockAmount;
                } else {
                    stock[city][resource] = 0;
                    demand[city][resource] = 0;
                }
            }
        }

        return { stock, demand };
    }

    function applyCargoToLimits(limits, origin, destination, cargo) {
        const newStock = {
            ...limits.stock,
            [origin]: {
                ...limits.stock[origin]
            }
        };

        const newDemand = {
            ...limits.demand,
            [destination]: {
                ...limits.demand[destination]
            }
        };

        for (const item of cargo) {
            newStock[origin][item.resource] = Math.max(
                0,
                newStock[origin][item.resource] - item.quantity
            );

            newDemand[destination][item.resource] = Math.max(
                0,
                newDemand[destination][item.resource] - item.quantity
            );
        }

        return {
            stock: newStock,
            demand: newDemand
        };
    }

    function expectedRetention(routeType, banditProbability) {
        if (routeType === 'guarded') return 1;

        return 1 - CONFIG.banditLossFraction * banditProbability;
    }

    function buildCargo(
        origin,
        destination,
        capacity,
        routeType,
        banditProbability,
        markets,
        limits,
        budget = Infinity
    ) {
        const retention = expectedRetention(routeType, banditProbability);
        const items = [];

        for (const resource of RESOURCES) {
            const source = markets[origin]?.[resource];
            const target = markets[destination]?.[resource];

            if (!source || !target) continue;

            const available = Math.min(
                limits.stock[origin]?.[resource] || 0,
                limits.demand[destination]?.[resource] || 0
            );

            if (available <= 0) continue;

            const unitExpectedProfit =
                retention * target.sell -
                source.buy;

            if (unitExpectedProfit <= 0) continue;

            items.push({
                resource,
                buy: source.buy,
                sell: target.sell,
                weight: source.weight,
                available,
                retention,
                unitExpectedProfit,
                profitPerWeight:
                    unitExpectedProfit / source.weight,
                roi:
                    unitExpectedProfit / source.buy
            });
        }

        /*
         * If the player cannot afford enough goods to fill this transport,
         * capital is the limiting resource and ROI should be prioritized.
         * Once the transport can be filled, profit per weight is prioritized.
         */
        const cheapestCostPerWeight = items.length
            ? Math.min(...items.map(x => x.buy / x.weight))
            : Infinity;

        const capitalLimited =
            Number.isFinite(budget) &&
            budget < cheapestCostPerWeight * capacity;

        items.sort((a, b) => {
            if (capitalLimited) {
                return (
                    b.roi - a.roi ||
                    b.profitPerWeight - a.profitPerWeight
                );
            }

            return (
                b.profitPerWeight - a.profitPerWeight ||
                b.roi - a.roi
            );
        });

        let remainingWeight = capacity;
        let remainingBudget = budget;
        const cargo = [];

        for (const item of items) {
            const maxByWeight = Math.floor(
                remainingWeight / item.weight
            );

            const maxByBudget =
                Number.isFinite(remainingBudget)
                    ? Math.floor(remainingBudget / item.buy)
                    : Infinity;

            const quantity = Math.min(
                item.available,
                maxByWeight,
                maxByBudget
            );

            if (quantity <= 0) continue;

            cargo.push({
                resource: item.resource,
                quantity,
                weight: item.weight,
                buy: item.buy,
                sell: item.sell,
                unitExpectedProfit: item.unitExpectedProfit,
                expectedProfit:
                    quantity * item.unitExpectedProfit
            });

            remainingWeight -= quantity * item.weight;

            if (Number.isFinite(remainingBudget)) {
                remainingBudget -= quantity * item.buy;
            }

            if (
                remainingWeight <= 0 ||
                (
                    Number.isFinite(remainingBudget) &&
                    remainingBudget <= 0
                )
            ) {
                break;
            }
        }

        /*
         * Fill any small remaining capacity/budget with lower-ranked
         * profitable goods when possible.
         */
        if (remainingWeight > 0) {
            for (const item of items) {
                const already = cargo.find(
                    x => x.resource === item.resource
                );

                const used = already?.quantity || 0;
                const left = item.available - used;

                if (left <= 0) continue;

                const maxByWeight = Math.floor(
                    remainingWeight / item.weight
                );

                const maxByBudget =
                    Number.isFinite(remainingBudget)
                        ? Math.floor(remainingBudget / item.buy)
                        : Infinity;

                const extra = Math.min(
                    left,
                    maxByWeight,
                    maxByBudget
                );

                if (extra <= 0) continue;

                if (already) {
                    already.quantity += extra;
                    already.expectedProfit +=
                        extra * item.unitExpectedProfit;
                } else {
                    cargo.push({
                        resource: item.resource,
                        quantity: extra,
                        weight: item.weight,
                        buy: item.buy,
                        sell: item.sell,
                        unitExpectedProfit: item.unitExpectedProfit,
                        expectedProfit:
                            extra * item.unitExpectedProfit
                    });
                }

                remainingWeight -= extra * item.weight;

                if (Number.isFinite(remainingBudget)) {
                    remainingBudget -= extra * item.buy;
                }

                if (
                    remainingWeight <= 0 ||
                    (
                        Number.isFinite(remainingBudget) &&
                        remainingBudget <= 0
                    )
                ) {
                    break;
                }
            }
        }

        const totalWeight = cargo.reduce(
            (sum, item) =>
                sum +
                item.quantity * item.weight,
            0
        );

        const purchaseCost = cargo.reduce(
            (sum, item) =>
                sum +
                item.quantity * item.buy,
            0
        );

        const grossExpectedProfit = cargo.reduce(
            (sum, item) =>
                sum +
                item.expectedProfit,
            0
        );

        return {
            cargo,
            totalWeight,
            purchaseCost,
            grossExpectedProfit
        };
    }

    function getRouteDistance(origin, destination, routeType) {
        return ROUTES[origin]?.[destination]?.[routeType] ?? null;
    }

    function makeLeg(
        origin,
        destination,
        routeType,
        transport,
        markets,
        limits,
        banditProbability,
        budget = Infinity
    ) {
        const distance = getRouteDistance(
            origin,
            destination,
            routeType
        );

        if (!distance) return null;

        const cargoPlan = buildCargo(
            origin,
            destination,
            transport.capacity,
            routeType,
            banditProbability,
            markets,
            limits,
            budget
        );

        if (!cargoPlan.cargo.length || cargoPlan.totalWeight <= 0) {
            return null;
        }

        const toll = routeType === 'guarded' ? 10 : 0;
        const fixedCost = transport.rent + toll;

        const netExpectedProfit =
            cargoPlan.grossExpectedProfit -
            fixedCost;

        if (netExpectedProfit <= 0) return null;

        const travelMinutes =
            distance / transport.speed;

        return {
            from: origin,
            to: destination,
            routeType,
            distance,
            toll,
            transport: {
                id: transport.id,
                name: transport.name,
                speed: transport.speed,
                capacity: transport.capacity,
                rent: transport.rent
            },
            cargo: cargoPlan.cargo,
            totalWeight: cargoPlan.totalWeight,
            grossExpectedProfit:
                cargoPlan.grossExpectedProfit,
            fixedCost,
            expectedProfit: netExpectedProfit,
            travelMinutes,
            expectedSilverPerHour:
                netExpectedProfit /
                travelMinutes *
                60
        };
    }

    function estimateGlobalMaxRate(markets, limits, banditProbability) {
        let best = 0;

        for (const origin of CITIES) {
            for (const destination of CITIES) {
                if (origin === destination) continue;

                for (const routeType of ['guarded', 'risky']) {
                    for (const transport of Object.values(TRANSPORTS)) {
                        const leg = makeLeg(
                            origin,
                            destination,
                            routeType,
                            transport,
                            markets,
                            limits,
                            banditProbability
                        );

                        if (leg) {
                            best = Math.max(
                                best,
                                leg.expectedProfit /
                                leg.travelMinutes
                            );
                        }
                    }
                }
            }
        }

        return best;
    }


    function bestBuffaloHubRate(
        city,
        markets,
        limits,
        banditProbability
    ) {
        let best = 0;

        for (const destination of CITIES) {
            if (destination === city) {
                continue;
            }

            for (const routeType of ['guarded', 'risky']) {
                const leg = makeLeg(
                    city,
                    destination,
                    routeType,
                    TRANSPORTS.buffalo,
                    markets,
                    limits,
                    banditProbability
                );

                if (!leg) {
                    continue;
                }

                /*
                 * A city is a strong "bulk trading hub" only if a Buffalo
                 * can be used close to full capacity there.
                 */
                if (
                    leg.totalWeight <
                    TRANSPORTS.buffalo.capacity *
                    CONFIG.buffaloFullWeightFraction
                ) {
                    continue;
                }

                best = Math.max(
                    best,
                    leg.expectedSilverPerHour
                );
            }
        }

        return best;
    }

    function choosePlannedTransportLegs(
        origin,
        destination,
        routeType,
        markets,
        limits,
        banditProbability,
        remainingMinutes
    ) {
        const horse = makeLeg(
            origin,
            destination,
            routeType,
            TRANSPORTS.horse,
            markets,
            limits,
            banditProbability
        );

        const buffalo = makeLeg(
            origin,
            destination,
            routeType,
            TRANSPORTS.buffalo,
            markets,
            limits,
            banditProbability
        );

        const walking = makeLeg(
            origin,
            destination,
            routeType,
            TRANSPORTS.walk,
            markets,
            limits,
            banditProbability
        );

        const buffaloFull =
            buffalo &&
            buffalo.totalWeight >=
                TRANSPORTS.buffalo.capacity *
                CONFIG.buffaloFullWeightFraction;

        const horseFits =
            horse &&
            horse.travelMinutes <= remainingMinutes;

        const buffaloFits =
            buffalo &&
            buffalo.travelMinutes <= remainingMinutes;

        /*
         * If the Buffalo is full and fits in the available time, default to
         * Buffalo for actual trading. It has the same raw weight throughput
         * as the Warhorse, but rent/toll is paid less often.
         *
         * The exception is a genuine repositioning move: if the destination
         * has substantially stronger future full-Buffalo opportunities than
         * the current city, use the Warhorse to get there faster.
         */
        if (buffaloFull && buffaloFits) {
            const originHubRate =
                bestBuffaloHubRate(
                    origin,
                    markets,
                    limits,
                    banditProbability
                );

            const destinationHubRate =
                bestBuffaloHubRate(
                    destination,
                    markets,
                    limits,
                    banditProbability
                );

            const reposition =
                horseFits &&
                destinationHubRate >
                    originHubRate *
                    CONFIG.repositionHubImprovement;

            if (reposition) {
                horse.strategyRole = 'reposition';
                return [horse];
            }

            buffalo.strategyRole = 'bulk';
            return [buffalo];
        }

        /*
         * Buffalo cannot be properly utilized here. Keep the available
         * faster/smaller alternatives so the route planner can move on.
         */
        const candidates = [
            horse,
            buffalo,
            walking
        ].filter(
            leg =>
                leg &&
                leg.travelMinutes <= remainingMinutes
        );

        for (const leg of candidates) {
            leg.strategyRole =
                leg.transport.id === TRANSPORTS.horse.id
                    ? 'reposition'
                    : 'trade';
        }

        return candidates;
    }

    function searchRoute({
        startCity,
        markets,
        limits,
        horizonMinutes,
        banditProbability,
        continuationValues = null,
        beamWidth = CONFIG.beamWidth,
        maxDepth = CONFIG.maxPlanDepth
    }) {
        const maxRate = estimateGlobalMaxRate(
            markets,
            limits,
            banditProbability
        );

        let beam = [
            {
                city: startCity,
                timeUsed: 0,
                profit: 0,
                limits,
                steps: []
            }
        ];

        let bestState = beam[0];

        function finalScore(state) {
            return (
                state.profit +
                (
                    continuationValues
                        ? continuationValues[state.city] || 0
                        : 0
                )
            );
        }

        function beamScore(state) {
            const remaining = Math.max(
                0,
                horizonMinutes - state.timeUsed
            );

            return (
                state.profit +
                remaining *
                maxRate *
                0.75
            );
        }

        for (let depth = 0; depth < maxDepth; depth++) {
            const expanded = [];

            for (const state of beam) {
                if (finalScore(state) > finalScore(bestState)) {
                    bestState = state;
                }

                for (const destination of CITIES) {
                    if (destination === state.city) continue;

                    for (const routeType of ['guarded', 'risky']) {
                        const remainingMinutes =
                            horizonMinutes -
                            state.timeUsed;

                        const candidateLegs =
                            choosePlannedTransportLegs(
                                state.city,
                                destination,
                                routeType,
                                markets,
                                state.limits,
                                banditProbability,
                                remainingMinutes
                            );

                        for (const leg of candidateLegs) {
                            const newTime =
                                state.timeUsed +
                                leg.travelMinutes;

                            if (newTime > horizonMinutes) {
                                continue;
                            }

                            const newLimits =
                                applyCargoToLimits(
                                    state.limits,
                                    state.city,
                                    destination,
                                    leg.cargo
                                );

                            expanded.push({
                                city: destination,
                                timeUsed: newTime,
                                profit:
                                    state.profit +
                                    leg.expectedProfit,
                                limits: newLimits,
                                steps: [
                                    ...state.steps,
                                    leg
                                ]
                            });
                        }
                    }
                }
            }

            if (!expanded.length) break;

            expanded.sort(
                (a, b) =>
                    beamScore(b) -
                    beamScore(a)
            );

            beam = expanded.slice(0, beamWidth);

            for (const state of beam) {
                if (finalScore(state) > finalScore(bestState)) {
                    bestState = state;
                }
            }
        }

        return {
            steps: bestState.steps,
            expectedProfit: bestState.profit,
            endCity: bestState.city,
            timeUsed: bestState.timeUsed,
            score: finalScore(bestState)
        };
    }

    function calculateContinuationValues(markets, banditProbability) {
        const values = {};
        const freshLimits = createFreshLimits(markets);

        for (const city of CITIES) {
            const result = searchRoute({
                startCity: city,
                markets,
                limits: freshLimits,
                horizonMinutes: CONFIG.nextDayLookaheadMinutes,
                banditProbability,
                continuationValues: null,
                beamWidth: 35,
                maxDepth: 12
            });

            values[city] = result.expectedProfit;
        }

        return values;
    }

    async function calculatePlannedRoute() {
        /*
         * Refresh authoritative game time before calculating how much of
         * the current trading day remains.
         */
        await syncGameClockFromDashboard();

        setStatus('Scanning markets...');

        const markets = await scanAllMarkets();

        const caravan = getCaravanState();

        if (caravan.type !== 'present') {
            throw new Error(
                'Could not locate the caravan after scanning all markets.'
            );
        }

        const startCity = caravan.city;

        const state = loadState();

        const banditProbability =
            Number(state.banditProbability) || 0;

        setStatus('Evaluating tomorrow positioning...');

        const continuationValues =
            calculateContinuationValues(
                markets,
                banditProbability
            );

        const horizonMinutes =
            secondsUntilReset() / 60;

        setStatus('Calculating full route...');

        const result = searchRoute({
            startCity,
            markets,
            limits: createLimits(markets),
            horizonMinutes,
            banditProbability,
            continuationValues
        });

        const validUntil =
            Date.now() +
            horizonMinutes *
            60 *
            1000;

        const plan = {
            generatedAt: Date.now(),
            startCity,
            expectedProfit: result.expectedProfit,
            expectedEndCity: result.endCity,
            expectedTravelMinutes: result.timeUsed,
            continuationValues,
            banditProbability,
            steps: result.steps
        };

        patchState({
            plan,
            nextStepIndex: 0,
            inTransitStepIndex: null,
            expectedArrivalReal: null,
            departureGameSeconds: null,
            expectedArrivalGameSeconds: null,
            arrivalBaseline: null,
            planValidUntilReal: validUntil,
            needsRecalcAtArrival: false,
            lastError: null,
            status:
                result.steps.length
                    ? `Plan ready: ${result.steps.length} legs`
                    : 'No profitable route found'
        });

        log('Generated plan:', plan);

        return plan;
    }

    async function calculateImmediateLeg() {
        const markets = await scanAllMarkets();
        const caravan = getCaravanState();

        if (caravan.type !== 'present') {
            throw new Error(
                'Could not locate the caravan after scanning all markets.'
            );
        }

        const origin = caravan.city;
        const limits = createLimits(markets);

        /*
         * Wealth is global and is shown in the market panel note.
         */
        const silver = getSilver();

        if (!Number.isFinite(silver)) {
            throw new Error(
                'Could not read current Demonic Silver.'
            );
        }

        let best = null;

        for (const destination of CITIES) {
            if (destination === origin) continue;

            for (const transport of Object.values(TRANSPORTS)) {
                const fixedCost =
                    transport.rent + 10; // guarded toll

                const buyingBudget =
                    Math.max(
                        0,
                        silver - fixedCost
                    );

                if (buyingBudget <= 0) {
                    continue;
                }

                const leg = makeLeg(
                    origin,
                    destination,
                    'guarded',
                    transport,
                    markets,
                    limits,
                    0,
                    buyingBudget
                );

                if (!leg) continue;

                /*
                 * Extra sanity check: never plan purchases plus travel
                 * above the player's current wealth.
                 */
                if (
                    leg.purchaseCost +
                    leg.fixedCost >
                    silver
                ) {
                    continue;
                }

                if (
                    !best ||
                    leg.expectedSilverPerHour >
                    best.expectedSilverPerHour
                ) {
                    best = leg;
                }
            }
        }

        return best;
    }

    function findActionForm(resource, actionText) {
        const card = findResourceCard(resource);
        if (!card) return null;

        return [
            ...card.querySelectorAll('.ec-card-actions form')
        ].find(form => {
            const button = form.querySelector('button');

            return normalize(button?.textContent) === actionText;
        }) || null;
    }

    async function buyResource(resource, quantity) {
        if (quantity <= 0) return true;

        const cachedCity =
            loadState().caravanCity;

        if (cachedCity) {
            const actualCity =
                await ensureCaravanMarket(
                    cachedCity
                );

            if (!actualCity) {
                throw new Error(
                    'Could not locate caravan market before buying.'
                );
            }
        }

        const info = parseResourceCard(resource);

        if (!info) {
            throw new Error(`Could not find ${resource}.`);
        }

        if (info.stock < quantity) {
            throw new Error(
                `${resource}: planned ${quantity}, only ${info.stock} stock remains.`
            );
        }

        let form = findActionForm(resource, 'Buy');
        let input = form?.querySelector('input[type="number"]');
        let button = form?.querySelector('button');

        /*
         * Recovery for stale "Prices only" DOM after a scan.
         */
        if (!input || !button) {
            const cachedCity =
                loadState().caravanCity;

            const actualCity =
                await ensureCaravanMarket(
                    cachedCity
                );

            if (actualCity) {
                form = findActionForm(resource, 'Buy');
                input = form?.querySelector('input[type="number"]');
                button = form?.querySelector('button');
            }
        }

        if (!input || !button) {
            throw new Error(
                `Buy controls missing for ${resource}. Current panel: ${getPanelNote() || 'unknown'}`
            );
        }

        setStatus(`Buying ${quantity} ${resource}...`);

        /*
         * Remember storage before buying. On mobile Safari the first DOM
         * mutation can be only the status message; the cargo fields can
         * appear slightly later.
         */
        const storedBefore =
            parseResourceCard(resource)?.stored || 0;

        setInputValue(input, quantity);
        await sleep(200);

        const mutation = waitForBodyMutation();

        button.click();

        await mutation;

        const purchaseApplied = await waitFor(
            () => {
                const now =
                    parseResourceCard(resource);

                return (
                    now &&
                    now.stored >=
                        storedBefore + quantity
                );
            },
            10000,
            100
        );

        if (!purchaseApplied) {
            const now =
                parseResourceCard(resource);

            throw new Error(
                `Purchase of ${quantity} ${resource} was not reflected in storage. ` +
                `Stored before: ${storedBefore}; now: ${now?.stored ?? 'unknown'}.`
            );
        }

        /*
         * Wait for the travel cargo controls to contain the newly purchased
         * resource as well. This prevents trying to load a stale form.
         */
        await waitFor(
            () => {
                const travelForm =
                    getTravelForm();

                if (!travelForm) {
                    return false;
                }

                const totalAvailable = [
                    ...travelForm.querySelectorAll(
                        '.ec-cargo-fields label'
                    )
                ]
                    .map(parseCargoLabel)
                    .filter(
                        lot =>
                            lot &&
                            lot.resource === resource
                    )
                    .reduce(
                        (sum, lot) =>
                            sum + lot.stored,
                        0
                    );

                return totalAvailable >= quantity;
            },
            10000,
            100
        );

        return true;
    }

    async function sellResource(
        resource,
        quantity,
        expectedCity = null
    ) {
        if (quantity <= 0) return 0;

        const targetCity =
            expectedCity ||
            loadState().caravanCity ||
            parseCityFromPanelNote();

        if (targetCity) {
            const actualCity =
                await ensureCaravanMarket(
                    targetCity
                );

            if (!actualCity) {
                throw new Error(
                    `Could not locate caravan market before selling ${resource}.`
                );
            }

            if (
                expectedCity &&
                actualCity !== expectedCity
            ) {
                throw new Error(
                    `Expected to sell ${resource} at ${expectedCity}, but caravan is at ${actualCity}.`
                );
            }
        }

        let info = parseResourceCard(resource);

        if (!info) {
            throw new Error(`Could not find ${resource}.`);
        }

        let remaining = Math.min(
            quantity,
            info.stored,
            info.demand
        );

        if (remaining <= 0) {
            return 0;
        }

        let soldTotal = 0;
        let failedAttempts = 0;

        for (
            let attempt = 0;
            attempt < 6 && remaining > 0;
            attempt++
        ) {
            const refreshCity =
                expectedCity ||
                targetCity;

            if (refreshCity) {
                const actualCity =
                    await ensureCaravanMarket(
                        refreshCity
                    );

                if (!actualCity) {
                    failedAttempts++;
                    await sleep(400);
                    continue;
                }
            }

            info = parseResourceCard(resource);

            if (!info) {
                failedAttempts++;
                await sleep(400);
                continue;
            }

            const amount = Math.min(
                remaining,
                info.stored,
                info.demand
            );

            if (amount <= 0) {
                break;
            }

            let form =
                findActionForm(
                    resource,
                    'Sell'
                );

            let input =
                form?.querySelector(
                    'input[type="number"]'
                );

            let button =
                form?.querySelector(
                    'button'
                );

            if (!input || !button) {
                if (refreshCity) {
                    await forceRefreshMarket(
                        refreshCity
                    );
                }

                form =
                    findActionForm(
                        resource,
                        'Sell'
                    );

                input =
                    form?.querySelector(
                        'input[type="number"]'
                    );

                button =
                    form?.querySelector(
                        'button'
                    );
            }

            if (!input || !button) {
                failedAttempts++;

                if (failedAttempts >= 3) {
                    throw new Error(
                        `Sell controls missing for ${resource} after repeated refreshes. ` +
                        `Current panel: ${getPanelNote() || 'unknown'}.`
                    );
                }

                await sleep(500);
                continue;
            }

            const storedBefore =
                info.stored;

            const silverBefore =
                getSilver();

            setStatus(
                `Selling ${amount} ${resource}...`
            );

            setInputValue(
                input,
                amount
            );

            await sleep(150);

            /*
             * The actual Trading Post HTML uses a normal form:
             *
             *   <form class="ec-expedition-form">
             *     <label>Quantity to sell<input ...></label>
             *     <button type="submit">Sell</button>
             *     <p class="ec-action-status"></p>
             *   </form>
             *
             * Submit the FORM rather than synthetically clicking the button.
             * This directly triggers the site's submit handler and is more
             * reliable when the Trading Post is hidden in the background.
             */
            const statusEl =
                form.querySelector(
                    '.ec-action-status'
                );

            const statusBefore =
                normalize(
                    statusEl?.textContent
                );

            const mutation =
                waitForBodyMutation();

            if (
                typeof form.requestSubmit ===
                'function'
            ) {
                form.requestSubmit(
                    button
                );
            } else {
                /*
                 * Older-browser fallback: dispatch a real submit event.
                 */
                form.dispatchEvent(
                    new SubmitEvent(
                        'submit',
                        {
                            bubbles: true,
                            cancelable: true,
                            submitter: button
                        }
                    )
                );
            }

            await mutation;

            let result = await waitFor(
                () => {
                    const nowInfo =
                        parseResourceCard(
                            resource
                        );

                    const silverNow =
                        getSilver();

                    const currentForm =
                        findActionForm(
                            resource,
                            'Sell'
                        );

                    const currentStatus =
                        normalize(
                            currentForm
                                ?.querySelector(
                                    '.ec-action-status'
                                )
                                ?.textContent
                        );

                    const storedChanged =
                        nowInfo &&
                        nowInfo.stored <
                            storedBefore;

                    const silverChanged =
                        Number.isFinite(
                            silverBefore
                        ) &&
                        Number.isFinite(
                            silverNow
                        ) &&
                        silverNow >
                            silverBefore;

                    const statusChanged =
                        currentStatus &&
                        currentStatus !==
                            statusBefore;

                    if (
                        storedChanged ||
                        silverChanged
                    ) {
                        return {
                            info: nowInfo,
                            silverNow,
                            storedChanged,
                            silverChanged,
                            status:
                                currentStatus
                        };
                    }

                    /*
                     * A changed status alone is not treated as success, but
                     * return it as a diagnostic if it explicitly reports an
                     * error so we don't blindly retry an invalid request.
                     */
                    if (
                        statusChanged &&
                        /error|failed|invalid|cannot|not enough|limit/i.test(
                            currentStatus
                        )
                    ) {
                        return {
                            explicitError:
                                currentStatus,
                            info: nowInfo,
                            silverNow
                        };
                    }

                    return null;
                },
                7000,
                100
            );

            if (
                result?.explicitError
            ) {
                throw new Error(
                    `Sell failed for ${resource}: ${result.explicitError}`
                );
            }

            if (!result && refreshCity) {
                await forceRefreshMarket(
                    refreshCity
                );

                const refreshedInfo =
                    parseResourceCard(
                        resource
                    );

                const refreshedSilver =
                    getSilver();

                const storedChanged =
                    refreshedInfo &&
                    refreshedInfo.stored <
                        storedBefore;

                const silverChanged =
                    Number.isFinite(
                        silverBefore
                    ) &&
                    Number.isFinite(
                        refreshedSilver
                    ) &&
                    refreshedSilver >
                        silverBefore;

                if (
                    storedChanged ||
                    silverChanged
                ) {
                    result = {
                        info: refreshedInfo,
                        silverNow: refreshedSilver,
                        storedChanged,
                        silverChanged
                    };
                }
            }

            if (!result) {
                failedAttempts++;

                setStatus(
                    `Retrying sale of ${resource} (${failedAttempts}/3)...`
                );

                if (failedAttempts >= 3) {
                    throw new Error(
                        `Sale of ${amount} ${resource} failed after 3 fresh-form attempts. ` +
                        `Stored remains ${storedBefore}.`
                    );
                }

                await sleep(600);
                continue;
            }

            failedAttempts = 0;

            let afterInfo =
                result.info;

            if (
                !afterInfo ||
                afterInfo.stored >= storedBefore
            ) {
                if (refreshCity) {
                    await forceRefreshMarket(
                        refreshCity
                    );
                }

                afterInfo =
                    parseResourceCard(
                        resource
                    );
            }

            let actuallySold =
                afterInfo &&
                afterInfo.stored <
                    storedBefore
                    ? storedBefore -
                        afterInfo.stored
                    : amount;

            actuallySold =
                Math.max(
                    0,
                    Math.min(
                        amount,
                        actuallySold
                    )
                );

            soldTotal +=
                actuallySold;

            remaining -=
                actuallySold;

            await sleep(150);
        }

        if (remaining > 0) {
            throw new Error(
                `Could not finish selling ${resource}. ` +
                `${remaining} still expected to be sold.`
            );
        }

        return soldTotal;
    }

    function snapshotStored() {
        const result = {};

        for (const resource of RESOURCES) {
            result[resource] =
                parseResourceCard(resource)?.stored || 0;
        }

        return result;
    }



    async function refreshTradingPostStateSilently(
        destination = null
    ) {
        /*
         * IMPORTANT:
         * Do NOT fetch/reload event_page.php here.
         *
         * A GET of the full event page can have side effects on unrelated
         * game UI/session state. Instead, refresh only the Trading Post by
         * closing and reopening its hidden interface.
         */
        await closeTradingPostQuietly();
        await sleep(120);

        if (!await ensureTradingPostOpen()) {
            return false;
        }

        await sleep(180);

        if (destination) {
            await selectMarket(destination);
            await sleep(120);
        }

        return true;
    }

    async function captureArrivalBaseline(destination) {
        if (!destination) {
            return null;
        }

        const state = loadState();

        if (
            state.arrivalBaseline?.destination === destination &&
            state.arrivalBaseline?.stored
        ) {
            return state.arrivalBaseline;
        }

        if (!await ensureTradingPostOpen()) {
            return null;
        }

        const ok = await selectMarket(destination);

        if (!ok) {
            return null;
        }

        const baseline = {
            destination,
            stored: snapshotStored(),
            capturedAt: Date.now()
        };

        patchState({
            arrivalBaseline: baseline
        });

        return baseline;
    }

    async function sellArrivedDelta(
        destination,
        baselineStored
    ) {
        if (!destination) {
            return {};
        }

        const actualCity =
            await ensureCaravanMarket(
                destination
            );

        if (
            !actualCity ||
            actualCity !== destination
        ) {
            throw new Error(
                `Could not establish caravan at ${destination} before selling arrived cargo.`
            );
        }

        const after = snapshotStored();
        const arrived = {};

        for (const resource of RESOURCES) {
            arrived[resource] = Math.max(
                0,
                (after[resource] || 0) -
                (baselineStored?.[resource] || 0)
            );
        }

        for (const resource of RESOURCES) {
            const quantity =
                arrived[resource] || 0;

            if (quantity <= 0) {
                continue;
            }

            await sellResource(
                resource,
                quantity,
                destination
            );
        }

        return arrived;
    }

    async function unloadArrivedCaravan() {
        const state = loadState();
        const cachedCaravan = getCaravanState();

        if (cachedCaravan.type !== 'arrived_ready') {
            return null;
        }

        const incomingIndex =
            state.inTransitStepIndex;

        let incomingStep = null;

        if (
            incomingIndex !== null &&
            state.plan?.steps?.[incomingIndex]
        ) {
            incomingStep =
                state.plan.steps[incomingIndex];
        }

        const destination =
            cachedCaravan.destination ||
            state.arrivalBaseline?.destination ||
            incomingStep?.to ||
            state.manualJourneyDestination;

        const baselineStored =
            state.arrivalBaseline?.destination === destination
                ? state.arrivalBaseline.stored
                : null;

        setStatus(
            destination
                ? `Arrived at ${SHORT_CITY[destination] || destination} — resolving automatically`
                : 'Caravan arrived — resolving automatically'
        );

        /*
         * Arrival is resolved by refreshing only the hidden Trading Post.
         * We deliberately avoid reloading/fetching the full event page.
         */
        if (
            !await refreshTradingPostStateSilently(
                destination
            )
        ) {
            throw new Error(
                'Could not refresh Trading Post after caravan arrival.'
            );
        }

        let liveCaravan = getCaravanState();

        /*
         * If the Trading Post still shows the old arrival state, retry its
         * own hidden interface a few times. Never reload the full game page.
         */
        for (
            let attempt = 0;
            attempt < 4 &&
            liveCaravan.type !== 'present';
            attempt++
        ) {
            if (liveCaravan.type === 'travelling') {
                setStatus(
                    `Travelling to ${SHORT_CITY[liveCaravan.destination] || liveCaravan.destination}`
                );
                return null;
            }

            await sleep(1000);

            if (
                !await refreshTradingPostStateSilently(
                    destination
                )
            ) {
                continue;
            }

            liveCaravan = getCaravanState();
        }

        if (liveCaravan.type !== 'present') {
            /*
             * Do NOT stop the automation. Keep trying on future ticks.
             */
            setStatus(
                destination
                    ? `Arrival at ${SHORT_CITY[destination] || destination} pending Trading Post refresh`
                    : 'Arrival pending Trading Post refresh'
            );

            return null;
        }

        const actualDestination =
            liveCaravan.city ||
            destination;

        /*
         * The caravan is already automatically unloaded at this point.
         * Compare destination storage with the pre-arrival snapshot and sell
         * the newly added cargo ourselves.
         */
        let arrived = {};

        if (baselineStored) {
            arrived =
                await sellArrivedDelta(
                    actualDestination,
                    baselineStored
                );

        } else if (incomingStep) {
            /*
             * Fallback for an older in-flight trip created before baseline
             * capture existed. Sell up to the expected incoming quantities,
             * limited by what is actually stored at the destination.
             */
            await selectMarket(
                actualDestination
            );

            const storedNow =
                snapshotStored();

            for (const item of incomingStep.cargo || []) {
                const quantity =
                    Math.min(
                        item.quantity,
                        storedNow[item.resource] || 0
                    );

                if (quantity <= 0) {
                    continue;
                }

                const sold =
                    await sellResource(
                        item.resource,
                        quantity,
                        actualDestination
                    );

                arrived[item.resource] =
                    sold;
            }
        }

        patchState({
            inTransitStepIndex: null,
            expectedArrivalReal: null,
            departureGameSeconds: null,
            expectedArrivalGameSeconds: null,
            manualJourneyDestination: null,
            arrivalBaseline: null,
            caravanCity:
                actualDestination ||
                null
        });

        return {
            city: actualDestination,
            arrived,
            incomingStep,
            automaticallyUnloaded: true
        };
    }

    function getTravelForm() {
        return [
            ...document.querySelectorAll(
                '#ecDialogBody > form.ec-expedition-form, #ecDialogBody form.ec-expedition-form'
            )
        ].find(form => {
            const labels = normalize(form.textContent);

            return (
                labels.includes('Destination') &&
                labels.includes('Transport for this journey') &&
                labels.includes('Load cargo and depart')
            );
        }) || null;
    }

    function getDestinationSelect(form) {
        return [
            ...form.querySelectorAll('select')
        ].find(select =>
            [...select.options].some(
                option =>
                    CITIES.some(
                        city =>
                            normalize(option.textContent).includes(city)
                    )
            )
        ) || null;
    }

    function getTransportSelect(form) {
        return [
            ...form.querySelectorAll('select')
        ].find(select =>
            [...select.options].some(
                option => option.value === 'walk'
            )
        ) || null;
    }

    function findDestinationOption(
        select,
        destination,
        routeType
    ) {
        const routeWord =
            routeType === 'guarded'
                ? 'Guarded'
                : 'Bandit risk';

        return [
            ...select.options
        ].find(option => {
            const text = normalize(option.textContent);

            return (
                text.includes(destination) &&
                text.includes(routeWord)
            );
        }) || null;
    }

    function parseCargoLabel(label) {
        const text = normalize(label.textContent);
        const input = label.querySelector('input[type="number"]');

        const match = text.match(
            /(.+?)\s*\(\s*stored\s*([\d,]+)\s*,\s*weight\s*([\d,]+)\s*\)/i
        );

        if (!match || !input) {
            return null;
        }

        const storedFromText =
            Number(match[2].replace(/,/g, ''));

        const maxAttr =
            Number(input.getAttribute('max'));

        return {
            resource: normalize(match[1]),
            stored:
                Number.isFinite(maxAttr) && maxAttr >= 0
                    ? maxAttr
                    : storedFromText,
            weight:
                Number(match[3].replace(/,/g, '')),
            input
        };
    }

    function fillCargo(form, cargo) {
        const labels = [
            ...form.querySelectorAll('.ec-cargo-fields label')
        ];

        const lots = labels
            .map(parseCargoLabel)
            .filter(Boolean);

        for (const lot of lots) {
            setInputValue(lot.input, 0);
        }

        for (const planned of cargo) {
            let remaining = planned.quantity;

            const matching = lots.filter(
                lot => lot.resource === planned.resource
            );

            for (const lot of matching) {
                if (remaining <= 0) break;

                const load = Math.min(
                    remaining,
                    lot.stored
                );

                setInputValue(lot.input, load);

                remaining -= load;
            }

            if (remaining > 0) {
                const visibleLots = lots.length
                    ? lots
                        .map(
                            lot =>
                                `${lot.resource}:${lot.stored}`
                        )
                        .join(', ')
                    : 'none';

                throw new Error(
                    `Could not load all ${planned.resource}. Missing ${remaining}. ` +
                    `Cargo fields currently visible: ${visibleLots}.`
                );
            }
        }

        return true;
    }

    async function executeLeg(leg, stepIndex = null) {
        const caravan = getCaravanState();

        if (caravan.type !== 'present') {
            throw new Error('Caravan is not present.');
        }

        if (caravan.city !== leg.from) {
            throw new Error(
                `Plan expects ${leg.from}, but caravan is at ${caravan.city}.`
            );
        }

        /*
         * IMPORTANT:
         * scanAllMarkets() changes the viewed market several times.
         * A non-caravan market is "Prices only" and has no Buy/Sell buttons.
         * Always restore the actual caravan market before buying.
         */
        const actualCaravanCity =
            await ensureCaravanMarket(
                leg.from
            );

        if (!actualCaravanCity) {
            throw new Error(
                'Could not find the market where the caravan is currently present.'
            );
        }

        if (actualCaravanCity !== leg.from) {
            throw new Error(
                `Plan expected caravan at ${leg.from}, but it is actually at ${actualCaravanCity}. Recalculate the route.`
            );
        }

        const stateNow = loadState();
        const greedyBudgetCheck =
            stateNow.mode === 'greedy';

        const actualCargo = [];

        /*
         * In greedy mode check wealth again before EACH purchase.
         * This makes the execution robust if money changed between
         * route calculation and buying.
         */
        for (const item of leg.cargo) {
            let quantity = item.quantity;

            if (greedyBudgetCheck) {
                const silverNow = getSilver();

                if (!Number.isFinite(silverNow)) {
                    throw new Error(
                        'Could not read current Demonic Silver while buying.'
                    );
                }

                const reservedTravelCost =
                    leg.fixedCost;

                const spendable =
                    Math.max(
                        0,
                        silverNow - reservedTravelCost
                    );

                quantity = Math.min(
                    quantity,
                    Math.floor(
                        spendable / item.buy
                    )
                );
            }

            if (quantity <= 0) {
                continue;
            }

            await buyResource(
                item.resource,
                quantity
            );

            actualCargo.push({
                ...item,
                quantity,
                expectedProfit:
                    quantity *
                    item.unitExpectedProfit
            });
        }

        if (!actualCargo.length) {
            throw new Error(
                'Not enough silver to buy any planned cargo after reserving travel costs.'
            );
        }

        /*
         * Force a complete market rebuild after buying. On iOS the resource
         * card may show the new Stored here value before the separate travel
         * cargo fields have been rebuilt.
         */
        const refreshedMarket =
            await forceRefreshMarket(leg.from);

        if (!refreshedMarket) {
            throw new Error(
                `Could not refresh ${leg.from} after buying cargo.`
            );
        }

        /*
         * Now wait for a fresh travel form that actually contains every
         * purchased cargo resource.
         */
        let form = await waitFor(
            () => {
                const current =
                    getTravelForm();

                if (!current) {
                    return null;
                }

                const lots = [
                    ...current.querySelectorAll(
                        '.ec-cargo-fields label'
                    )
                ]
                    .map(parseCargoLabel)
                    .filter(Boolean);

                const enough = actualCargo.every(
                    planned =>
                        lots
                            .filter(
                                lot =>
                                    lot.resource ===
                                    planned.resource
                            )
                            .reduce(
                                (sum, lot) =>
                                    sum + lot.stored,
                                0
                            ) >= planned.quantity
                );

                return enough
                    ? current
                    : null;
            },
            15000,
            150
        );

        if (!form) {
            const currentForm = getTravelForm();

            const visibleLots = currentForm
                ? [
                    ...currentForm.querySelectorAll(
                        '.ec-cargo-fields label'
                    )
                ]
                    .map(parseCargoLabel)
                    .filter(Boolean)
                    .map(
                        lot =>
                            `${lot.resource}:${lot.stored}`
                    )
                    .join(', ')
                : 'no travel form';

            throw new Error(
                `Travel cargo list did not contain the purchased goods. ` +
                `Visible lots: ${visibleLots || 'none'}.`
            );
        }

        let destinationSelect = getDestinationSelect(form);
        let transportSelect = getTransportSelect(form);

        if (!destinationSelect || !transportSelect) {
            throw new Error('Travel controls not found.');
        }

        const destinationOption = findDestinationOption(
            destinationSelect,
            leg.to,
            leg.routeType
        );

        if (!destinationOption) {
            throw new Error(
                `Could not find ${leg.routeType} route to ${leg.to}.`
            );
        }

        destinationSelect.value = destinationOption.value;
        destinationSelect.dispatchEvent(
            new Event('change', { bubbles: true })
        );

        const transportOption = [
            ...transportSelect.options
        ].find(
            option =>
                option.value ===
                leg.transport.id
        );

        if (!transportOption) {
            throw new Error(
                `Transport unavailable: ${leg.transport.name}`
            );
        }

        transportSelect.value = transportOption.value;
        transportSelect.dispatchEvent(
            new Event('change', { bubbles: true })
        );

        /*
         * Route/transport changes may rebuild the controls. Re-fetch the
         * live travel form before filling cargo.
         */
        await sleep(150);

        form = getTravelForm();

        if (!form) {
            throw new Error(
                'Travel form disappeared after selecting route/transport.'
            );
        }

        destinationSelect = getDestinationSelect(form);
        transportSelect = getTransportSelect(form);

        if (!destinationSelect || !transportSelect) {
            throw new Error(
                'Travel controls disappeared after selecting route/transport.'
            );
        }

        const liveDestinationOption =
            findDestinationOption(
                destinationSelect,
                leg.to,
                leg.routeType
            );

        if (liveDestinationOption) {
            destinationSelect.value =
                liveDestinationOption.value;
        }

        const liveTransportOption = [
            ...transportSelect.options
        ].find(
            option =>
                option.value ===
                leg.transport.id
        );

        if (liveTransportOption) {
            transportSelect.value =
                liveTransportOption.value;
        }

        fillCargo(form, actualCargo);

        const departButton = [
            ...form.querySelectorAll('button')
        ].find(
            button =>
                normalize(button.textContent) ===
                'Load cargo and depart'
        );

        if (!departButton) {
            throw new Error('Depart button not found.');
        }

        setStatus(
            `Departing ${SHORT_CITY[leg.from]} → ${SHORT_CITY[leg.to]}...`
        );

        const expectedArrivalReal =
            Date.now() +
            leg.travelMinutes *
            60 *
            1000;

        const departureGameSeconds =
            getGameClock().seconds;

        const expectedArrivalGameSeconds =
            (
                departureGameSeconds +
                Math.round(
                    leg.travelMinutes * 60
                )
            ) % 86400;

        const state = loadState();

        patchState({
            inTransitStepIndex: stepIndex,
            expectedArrivalReal,
            departureGameSeconds,
            expectedArrivalGameSeconds,
            caravanCity: null,
            nextStepIndex:
                stepIndex !== null
                    ? stepIndex + 1
                    : state.nextStepIndex,
            status:
                `Travelling to ${SHORT_CITY[leg.to]}`
        });

        departButton.click();

        await sleep(CONFIG.actionDelay);

        /*
         * While the caravan is travelling, snapshot storage at the
         * destination. The game auto-unloads on refreshed state, so this
         * baseline is how we later identify exactly which goods arrived.
         */
        await captureArrivalBaseline(
            leg.to
        );

        return true;
    }

    async function executeNextPlannedStep() {
        const state = loadState();

        if (!state.plan) {
            await calculatePlannedRoute();
        }

        const refreshed = loadState();
        const index = refreshed.nextStepIndex;
        const step = refreshed.plan?.steps?.[index];

        if (!step) {
            setStatus('Daily plan complete');
            return false;
        }

        return executeLeg(step, index);
    }

    async function executeImmediateTrade() {
        setStatus('Finding best immediate guarded trade...');

        const leg = await calculateImmediateLeg();

        if (!leg) {
            setStatus('No profitable guarded trade found');
            return false;
        }

        patchState({
            plan: {
                generatedAt: Date.now(),
                startCity: leg.from,
                expectedProfit: leg.expectedProfit,
                expectedEndCity: leg.to,
                expectedTravelMinutes: leg.travelMinutes,
                steps: [leg],
                temporaryImmediate: true
            },
            nextStepIndex: 0,
            inTransitStepIndex: null,
            expectedArrivalReal: null,
            departureGameSeconds: null,
            expectedArrivalGameSeconds: null,
            planValidUntilReal:
                Date.now() +
                secondsUntilReset() *
                1000,
            needsRecalcAtArrival: false
        });

        await executeLeg(leg, 0);

        return true;
    }

    async function handleArrival() {
        const before = loadState();

        const expectedArrival =
            before.expectedArrivalReal;

        const result =
            await unloadArrivedCaravan();

        if (!result) return;

        const now = Date.now();

        const late =
            expectedArrival &&
            now >
            expectedArrival +
            CONFIG.lateArrivalReplanMinutes *
            60 *
            1000;

        const after = loadState();

        const resetExpired =
            after.planValidUntilReal &&
            now >
            after.planValidUntilReal;

        if (
            after.mode === 'planned' &&
            (
                late ||
                resetExpired ||
                after.needsRecalcAtArrival
            )
        ) {
            setStatus(
                late
                    ? 'Recovered late arrival — recalculating'
                    : 'Plan expired — recalculating'
            );

            await calculatePlannedRoute();

            if (loadState().running) {
                await executeNextPlannedStep();
            }

            return;
        }

        if (after.mode === 'planned') {
            await executeNextPlannedStep();

        } else {
            patchState({
                plan: null,
                nextStepIndex: 0
            });

            await executeImmediateTrade();
        }
    }

    async function manualRecalculate() {
        const state = loadState();
        let caravan = getCaravanState();

        if (caravan.type === 'unknown') {
            await scanAllMarkets();
            caravan = getCaravanState();
        }

        if (caravan.type === 'travelling') {
            patchState({
                needsRecalcAtArrival: true,
                status: 'Recalculation queued for arrival'
            });

            return;
        }

        if (caravan.type === 'arrived_ready') {
            patchState({
                needsRecalcAtArrival: true
            });

            await handleArrival();

            return;
        }

        if (caravan.type !== 'present') {
            throw new Error('Caravan state is unknown.');
        }

        if (state.mode === 'planned') {
            await calculatePlannedRoute();

            if (loadState().running) {
                await executeNextPlannedStep();
            }

        } else {
            patchState({
                plan: null,
                nextStepIndex: 0
            });

            if (loadState().running) {
                await executeImmediateTrade();
            } else {
                setStatus('Immediate mode ready');
            }
        }
    }

    let resetHandling = false;

    async function handleMidnightReset() {
        if (resetHandling) return;

        resetHandling = true;

        try {
            const state = loadState();

            patchState({
                plan: null,
                nextStepIndex: 0,
                planValidUntilReal: null,
                needsRecalcAtArrival: false,
                status: '00:00 reset detected'
            });

            if (!state.running) return;

            await sleep(3000);

            const caravan = getCaravanState();

            if (caravan.type === 'present') {
                if (state.mode === 'planned') {
                    await calculatePlannedRoute();
                    await executeNextPlannedStep();
                } else {
                    await executeImmediateTrade();
                }

            } else if (
                caravan.type === 'travelling' ||
                caravan.type === 'arrived_ready'
            ) {
                patchState({
                    needsRecalcAtArrival: true,
                    status:
                        'Reset occurred during journey — replan on arrival'
                });
            }

        } finally {
            resetHandling = false;
        }
    }

    async function closeTradingPostQuietly() {
        if (!tradingPostIsOpen()) {
            return;
        }

        const close = document.querySelector('#ecClose');

        if (close) {
            close.click();
            await sleep(50);
        }
    }

    async function runSilentTradeOperation(fn) {
        const wasOpen = tradingPostIsOpen();
        const previousFocus = document.activeElement;
        const dialog = document.querySelector('#ecDialog');

        /*
         * CSS alone is not reliable for <dialog> elements in Safari because
         * an open dialog is rendered in the browser's top layer.
         *
         * Hard-hide the native dialog element itself BEFORE any automation
         * opens it. The DOM remains fully usable by JavaScript, but the game
         * window and backdrop cannot become visible to the player.
         */
        const oldDialogStyle = dialog
            ? {
                display: dialog.style.getPropertyValue('display'),
                displayPriority: dialog.style.getPropertyPriority('display'),
                visibility: dialog.style.getPropertyValue('visibility'),
                visibilityPriority: dialog.style.getPropertyPriority('visibility'),
                opacity: dialog.style.getPropertyValue('opacity'),
                opacityPriority: dialog.style.getPropertyPriority('opacity'),
                pointerEvents: dialog.style.getPropertyValue('pointer-events'),
                pointerEventsPriority: dialog.style.getPropertyPriority('pointer-events')
            }
            : null;

        document.body.classList.add('vat-silent-trade');

        if (dialog) {
            dialog.style.setProperty(
                'display',
                'none',
                'important'
            );

            dialog.style.setProperty(
                'visibility',
                'hidden',
                'important'
            );

            dialog.style.setProperty(
                'opacity',
                '0',
                'important'
            );

            dialog.style.setProperty(
                'pointer-events',
                'none',
                'important'
            );
        }

        try {
            return await fn();

        } finally {
            if (!wasOpen) {
                await closeTradingPostQuietly();
            }

            /*
             * Restore native dialog styles only after it has been closed.
             * If the player had the Trading Post open before automation
             * started, restore it exactly as it was.
             */
            if (dialog && oldDialogStyle) {
                const restoreProp = (
                    name,
                    value,
                    priority
                ) => {
                    if (value) {
                        dialog.style.setProperty(
                            name,
                            value,
                            priority || ''
                        );
                    } else {
                        dialog.style.removeProperty(
                            name
                        );
                    }
                };

                restoreProp(
                    'display',
                    oldDialogStyle.display,
                    oldDialogStyle.displayPriority
                );

                restoreProp(
                    'visibility',
                    oldDialogStyle.visibility,
                    oldDialogStyle.visibilityPriority
                );

                restoreProp(
                    'opacity',
                    oldDialogStyle.opacity,
                    oldDialogStyle.opacityPriority
                );

                restoreProp(
                    'pointer-events',
                    oldDialogStyle.pointerEvents,
                    oldDialogStyle.pointerEventsPriority
                );
            }

            document.body.classList.remove('vat-silent-trade');

            try {
                if (
                    previousFocus &&
                    typeof previousFocus.focus === 'function'
                ) {
                    previousFocus.focus({
                        preventScroll: true
                    });
                }
            } catch (_) {}
        }
    }

    let automationBusy = false;

    async function automationTickCore() {
        if (automationBusy) return;

        const state = loadState();
        const clock = getGameClock();

        /*
         * CRITICAL: while one of our caravans is travelling, do not touch
         * the Trading Post at all. Opening/closing it every automation tick
         * can disrupt whatever else the player is doing on the event page.
         *
         * We already know the journey duration when we depart, so simply
         * wait against the authoritative game clock. Only once that ETA is
         * reached do we start querying Trading Post state again.
         */
        if (
            state.running &&
            state.inTransitStepIndex !== null &&
            !hasReachedExpectedGameArrival(
                state,
                clock.seconds
            )
        ) {
            const step =
                state.plan?.steps?.[
                    state.inTransitStepIndex
                ];

            const remaining =
                gameTimeUntilExpectedArrival(
                    state,
                    clock.seconds
                );

            patchState({
                lastGameSeconds: clock.seconds,
                status:
                    step
                        ? `Travelling to ${SHORT_CITY[step.to] || step.to}` +
                          (
                              Number.isFinite(remaining)
                                  ? ` — ${formatMinutes(remaining / 60)} remaining`
                                  : ''
                          )
                        : 'Caravan travelling'
            });

            return;
        }

        if (
            state.lastGameSeconds !== null &&
            clock.seconds <
                state.lastGameSeconds -
                3600
        ) {
            patchState({
                lastGameSeconds: clock.seconds
            });

            if (state.running) {
                await handleMidnightReset();
            }

            return;
        }

        patchState({
            lastGameSeconds: clock.seconds
        });

        if (!state.running) return;

        automationBusy = true;

        try {
            if (!await ensureTradingPostOpen()) {
                setStatus('Waiting for Trading Post');
                return;
            }

            const current = getCaravanState();

            if (current.type === 'arrived_ready') {
                await handleArrival();
                return;
            }

            /*
             * A background/server refresh may auto-unload the caravan before
             * we ever observe an "arrived_ready" state. If a trip is still
             * recorded but the live market already says "Caravan present" at
             * its destination, process the arrival immediately.
             */
            const arrivalState = loadState();

            if (
                current.type === 'present' &&
                arrivalState.inTransitStepIndex !== null
            ) {
                const incoming =
                    arrivalState.plan?.steps?.[
                        arrivalState.inTransitStepIndex
                    ];

                if (
                    incoming &&
                    current.city === incoming.to
                ) {
                    /*
                     * Temporarily expose it to handleArrival as an arrival.
                     * unloadArrivedCaravan will see the live present state on
                     * the refreshed market and sell the stored delta.
                     */
                    const baseline =
                        arrivalState.arrivalBaseline;

                    let arrived = {};

                    if (
                        baseline?.destination ===
                        current.city
                    ) {
                        arrived =
                            await sellArrivedDelta(
                                current.city,
                                baseline.stored
                            );

                    } else {
                        const storedNow =
                            snapshotStored();

                        for (const item of incoming.cargo || []) {
                            const quantity =
                                Math.min(
                                    item.quantity,
                                    storedNow[item.resource] || 0
                                );

                            if (quantity > 0) {
                                const sold =
                                    await sellResource(
                                        item.resource,
                                        quantity,
                                        current.city
                                    );

                                arrived[item.resource] =
                                    sold;
                            }
                        }
                    }

                    patchState({
                        inTransitStepIndex: null,
                        expectedArrivalReal: null,
                        manualJourneyDestination: null,
                        arrivalBaseline: null,
                        caravanCity: current.city
                    });

                    const afterArrival =
                        loadState();

                    if (afterArrival.mode === 'planned') {
                        await executeNextPlannedStep();
                    } else {
                        await executeImmediateTrade();
                    }

                    return;
                }
            }

            if (current.type === 'travelling') {
                const liveState = loadState();

                /*
                 * Cache journeys that were already in progress when the
                 * script started, so recovery survives a reload.
                 */
                if (
                    current.destination &&
                    (
                        liveState.inTransitStepIndex === null ||
                        !liveState.plan
                    )
                ) {
                    liveState.manualJourneyDestination =
                        current.destination;

                    localStorage.setItem(
                        STORAGE_KEY,
                        JSON.stringify(liveState)
                    );
                }

                /*
                 * If the script starts mid-journey, take the same
                 * pre-arrival destination snapshot now. That allows
                 * automatic unload recovery without knowing the cargo in
                 * advance.
                 */
                if (
                    current.destination &&
                    !loadState().arrivalBaseline
                ) {
                    await captureArrivalBaseline(
                        current.destination
                    );
                }

                if (
                    liveState.planValidUntilReal &&
                    Date.now() >
                    liveState.planValidUntilReal
                ) {
                    patchState({
                        needsRecalcAtArrival: true,
                        status:
                            `Travelling to ${SHORT_CITY[current.destination] || current.destination} — replan after arrival`
                    });

                } else {
                    setStatus(
                        `Travelling to ${SHORT_CITY[current.destination] || current.destination}`
                    );
                }

                return;
            }

            if (current.type === 'unknown') {
                setStatus('Locating caravan...');

                await scanAllMarkets();

                const located = getCaravanState();

                if (located.type !== 'present') {
                    setStatus('Could not locate caravan');
                    return;
                }
            } else if (current.type !== 'present') {
                setStatus('Waiting for caravan state');
                return;
            }

            const liveState = loadState();

            if (liveState.mode === 'planned') {
                if (
                    !liveState.plan ||
                    (
                        liveState.planValidUntilReal &&
                        Date.now() >
                        liveState.planValidUntilReal
                    )
                ) {
                    await calculatePlannedRoute();
                }

                await executeNextPlannedStep();

            } else {
                await executeImmediateTrade();
            }

        } catch (error) {
            errorLog(error);

            patchState({
                running: false,
                lastError: error.message,
                status: `Paused: ${error.message}`
            });

        } finally {
            automationBusy = false;
        }
    }

    async function automationTick() {
        return runSilentTradeOperation(
            automationTickCore
        );
    }

    let panel = null;

    function createPanel() {
        if (document.querySelector('#veyraAutoTraderPanel')) {
            return;
        }

        panel = document.createElement('div');

        panel.id = 'veyraAutoTraderPanel';

        panel.innerHTML = `
<style>
body.vat-silent-trade #ecDialog {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
    position: fixed !important;
    left: -10000px !important;
    top: -10000px !important;
    width: 1px !important;
    height: 1px !important;
    max-width: 1px !important;
    max-height: 1px !important;
    overflow: hidden !important;
}

body.vat-silent-trade #ecDialog::backdrop {
    background: transparent !important;
    opacity: 0 !important;
    pointer-events: none !important;
}

body.vat-silent-trade .ec-dialogue-dock,
body.vat-silent-trade #battleDrawerBackdrop {
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
}

#veyraAutoTraderPanel {
    position: fixed;
    top: 8px;
    left: 8px;
    width: 330px;
    max-width: calc(100vw - 16px);
    z-index: 2147483647;
    background: rgba(20, 21, 30, .97);
    color: #f1f1f5;
    border: 1px solid #4b506a;
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,.65);
    font-family: Arial, sans-serif;
    font-size: 12px;
    overflow: hidden;
}

#veyraAutoTraderPanel:not(.minimized) {
    left: 8px !important;
    transform: none !important;
}

#veyraAutoTraderPanel * {
    box-sizing: border-box;
}

#vatHeader {
    min-height: 38px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 8px;
    background: #292c3d;
    cursor: default;
}

#vatHeaderTitle {
    flex: 1;
    font-weight: 700;
    font-size: 14px;
}

#vatMiniStatus {
    font-size: 10px;
    opacity: .75;
    white-space: nowrap;
}

.vatIconButton {
    width: 28px;
    height: 26px;
    padding: 0;
    border: 1px solid #4d526f;
    border-radius: 6px;
    background: #34384d;
    color: white;
    cursor: pointer;
}

#vatBody {
    padding: 9px;
}

.vatRow {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 8px;
}

.vatRow label {
    flex: 1;
}

#veyraAutoTraderPanel select,
#veyraAutoTraderPanel input[type="number"] {
    background: #2c3043;
    color: white;
    border: 1px solid #4b506a;
    border-radius: 5px;
    padding: 5px;
    font-size: 12px;
}

#vatBanditProbability {
    width: 64px;
}

.vatButtons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-bottom: 8px;
}

.vatButton {
    border: 0;
    border-radius: 6px;
    padding: 8px 6px;
    cursor: pointer;
    font-weight: 700;
    background: #404761;
    color: white;
}

.vatButtonPrimary {
    background: #356a47;
}

.vatButtonStop {
    background: #713b42;
}

.vatButtonRecalc {
    grid-column: span 2;
    background: #59517b;
}

#vatStatus {
    padding: 7px;
    border-radius: 6px;
    background: rgba(255,255,255,.055);
    margin-bottom: 8px;
    line-height: 1.35;
}

.vatInfoGrid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 3px 8px;
    margin-bottom: 8px;
    font-size: 11px;
}

.vatInfoGrid .k {
    opacity: .65;
}

#vatPlan {
    max-height: 285px;
    overflow-y: auto;
    border-top: 1px solid #363a4e;
    padding-top: 7px;
}

.vatPlanStep {
    border: 1px solid #383d53;
    border-radius: 6px;
    padding: 6px;
    margin-bottom: 6px;
    background: rgba(255,255,255,.03);
}

.vatPlanStep.current {
    border-color: #a9a25a;
    background: rgba(169,162,90,.08);
}

.vatPlanStep.done {
    opacity: .42;
}

.vatRoute {
    font-weight: 700;
    margin-bottom: 3px;
}

.vatSmall {
    font-size: 10px;
    opacity: .75;
    line-height: 1.3;
}

#veyraAutoTraderPanel.minimized {
    width: auto;
    min-width: 118px;
    left: 50% !important;
    right: auto !important;
    transform: translateX(-50%);
}

#veyraAutoTraderPanel.minimized #vatBody {
    display: none;
}

#veyraAutoTraderPanel.minimized #vatHeader {
    cursor: pointer;
}
</style>

<div id="vatHeader">
    <div id="vatHeaderTitle">Auto Trader</div>
    <div id="vatMiniStatus">Stopped</div>

    <button
        class="vatIconButton"
        id="vatMinimize"
        title="Minimize"
    >
        —
    </button>
</div>

<div id="vatBody">

    <div class="vatRow">
        <label>Mode</label>

        <select id="vatMode">
            <option value="planned">
                Planned / Future-aware
            </option>

            <option value="greedy">
                Immediate / Guarded
            </option>
        </select>
    </div>

    <div class="vatRow">
        <label>Bandit chance</label>

        <input
            id="vatBanditProbability"
            type="number"
            min="0"
            max="100"
            step="1"
        >

        <span>%</span>
    </div>

    <div class="vatButtons">

        <button
            class="vatButton vatButtonPrimary"
            id="vatStart"
        >
            Start / Resume
        </button>

        <button
            class="vatButton vatButtonStop"
            id="vatStop"
        >
            Stop
        </button>

        <button
            class="vatButton vatButtonRecalc"
            id="vatRecalculate"
        >
            Recalculate Route
        </button>

    </div>

    <div id="vatStatus">
        Stopped
    </div>

    <div class="vatInfoGrid">

        <div class="k">Caravan</div>
        <div id="vatCaravan">—</div>

        <div class="k">Expected profit</div>
        <div id="vatProfit">—</div>

        <div class="k">End city</div>
        <div id="vatEndCity">—</div>

    </div>

    <div id="vatPlan"></div>

</div>
`;

        document.body.appendChild(panel);

        bindPanelEvents();
        renderPanel();
    }

    function bindPanelEvents() {
        const minimize = panel.querySelector('#vatMinimize');
        const header = panel.querySelector('#vatHeader');

        minimize.addEventListener('click', event => {
            event.stopPropagation();

            const state = loadState();

            patchState({
                minimized: !state.minimized
            });
        });

        header.addEventListener('click', event => {
            if (event.target === minimize) return;

            const state = loadState();

            if (state.minimized) {
                patchState({
                    minimized: false
                });
            }
        });

        panel.querySelector('#vatMode').addEventListener(
            'change',
            event => {
                patchState({
                    mode: event.target.value,
                    plan: null,
                    nextStepIndex: 0
                });
            }
        );

        panel.querySelector('#vatBanditProbability').addEventListener(
            'input',
            event => {
                const raw = event.target.value;

                if (raw === '') {
                    return;
                }

                const value = Math.max(
                    0,
                    Math.min(
                        100,
                        Number(raw) || 0
                    )
                );

                const state = loadState();
                state.banditProbability = value / 100;

                localStorage.setItem(
                    STORAGE_KEY,
                    JSON.stringify(state)
                );
            }
        );

        panel.querySelector('#vatBanditProbability').addEventListener(
            'blur',
            event => {
                if (event.target.value === '') {
                    event.target.value = Math.round(
                        loadState().banditProbability * 100
                    );
                }

                renderPanel();
            }
        );

        panel.querySelector('#vatStart').addEventListener(
            'click',
            async () => {
                patchState({
                    running: true,
                    lastError: null,
                    status: 'Starting...'
                });

                await automationTick();
            }
        );

        panel.querySelector('#vatStop').addEventListener(
            'click',
            () => {
                patchState({
                    running: false,
                    status: 'Stopped'
                });
            }
        );

        panel.querySelector('#vatRecalculate').addEventListener(
            'click',
            async () => {
                if (automationBusy) return;

                automationBusy = true;

                try {
                    await runSilentTradeOperation(
                        manualRecalculate
                    );

                } catch (error) {
                    errorLog(error);

                    patchState({
                        running: false,
                        lastError: error.message,
                        status: `Paused: ${error.message}`
                    });

                } finally {
                    automationBusy = false;
                }
            }
        );
    }

    function renderPlan(state) {
        const container = document.querySelector('#vatPlan');

        if (!container) return;

        const steps = state.plan?.steps || [];

        if (!steps.length) {
            container.innerHTML =
                `<div class="vatSmall">No route calculated.</div>`;

            return;
        }

        container.innerHTML = steps
            .map((step, index) => {
                let cls = 'vatPlanStep';

                if (index < state.nextStepIndex) {
                    cls += ' done';
                }

                if (index === state.nextStepIndex) {
                    cls += ' current';
                }

                const cargo = step.cargo
                    .map(
                        item =>
                            `${formatNumber(item.quantity)} ${item.resource}`
                    )
                    .join('<br>');

                return `
<div class="${cls}">

    <div class="vatRoute">
        ${index + 1}.
        ${SHORT_CITY[step.from]}
        →
        ${SHORT_CITY[step.to]}
    </div>

    <div class="vatSmall">
        ${step.routeType === 'guarded'
            ? '🛡 Guarded'
            : '⚠ Risky'
        }
        |
        ${step.transport.name}
        ${step.strategyRole === 'bulk'
            ? ' · Bulk'
            : step.strategyRole === 'reposition'
                ? ' · Reposition'
                : ''
        }
        |
        ${formatMinutes(step.travelMinutes)}
    </div>

    <div class="vatSmall">
        ${cargo}
    </div>

    <div class="vatSmall">
        Weight:
        ${formatNumber(step.totalWeight)}
        /
        ${formatNumber(step.transport.capacity)}
        · EV:
        +${formatNumber(step.expectedProfit)}
    </div>

</div>
`;
            })
            .join('');
    }

    function renderPanel() {
        const p = document.querySelector('#veyraAutoTraderPanel');

        if (!p) return;

        const state = loadState();

        p.classList.toggle(
            'minimized',
            state.minimized
        );

        const minimize = p.querySelector('#vatMinimize');

        if (minimize) {
            minimize.textContent =
                state.minimized
                    ? '+'
                    : '—';

            minimize.title =
                state.minimized
                    ? 'Expand'
                    : 'Minimize';
        }

        const mode = p.querySelector('#vatMode');

        if (mode) {
            mode.value = state.mode;
        }

        const bandit = p.querySelector('#vatBanditProbability');

        if (
            bandit &&
            document.activeElement !== bandit
        ) {
            bandit.value = Math.round(
                state.banditProbability * 100
            );
        }

        const status = p.querySelector('#vatStatus');

        if (status) {
            status.textContent = state.status;
        }

        const mini = p.querySelector('#vatMiniStatus');

        if (mini) {
            mini.textContent =
                state.running
                    ? 'RUNNING'
                    : 'STOPPED';
        }

        const caravanEl = p.querySelector('#vatCaravan');

        if (caravanEl) {
            const c = getCaravanState();

            if (c.type === 'present') {
                caravanEl.textContent =
                    SHORT_CITY[c.city] ||
                    c.city;

            } else if (c.type === 'travelling') {
                caravanEl.textContent =
                    `→ ${SHORT_CITY[c.destination] || c.destination}`;

            } else if (c.type === 'arrived_ready') {
                caravanEl.textContent =
                    `Arrived: ${SHORT_CITY[c.destination] || c.destination}`;

            } else {
                caravanEl.textContent =
                    'Unknown';
            }
        }

        const profit = p.querySelector('#vatProfit');

        if (profit) {
            profit.textContent =
                state.plan
                    ? `+${formatNumber(state.plan.expectedProfit)}`
                    : '—';
        }

        const endCity = p.querySelector('#vatEndCity');

        if (endCity) {
            endCity.textContent =
                state.plan?.expectedEndCity
                    ? SHORT_CITY[
                        state.plan.expectedEndCity
                    ] ||
                    state.plan.expectedEndCity
                    : '—';
        }

        renderPlan(state);
    }

    async function startup() {
        if (location.pathname !== '/event_page.php') {
            return;
        }

        createPanel();

        /*
         * game_dash.php contains the authoritative server/game clock.
         * Fetch it silently; no navigation or visible window is opened.
         */
        await syncGameClockFromDashboard();

        setInterval(
            syncGameClockFromDashboard,
            5 * 60 * 1000
        );

        setInterval(
            renderPanel,
            1000
        );

        setInterval(
            automationTick,
            CONFIG.tickInterval
        );

        const state = loadState();

        if (state.running) {
            setTimeout(
                automationTick,
                1500
            );
        }

        log(
            `Veyra Auto Trader v${SCRIPT_VERSION} loaded.`
        );
    }

    if (document.readyState === 'loading') {
        document.addEventListener(
            'DOMContentLoaded',
            startup,
            {
                once: true
            }
        );
    } else {
        startup();
    }

})();
