/**
 * Expose a function to the page if it does not exist
 *
 * NOTE:
 * Rewrite it to 'upsertFunction' after updating Puppeteer to 20.6 or higher
 * using page.removeExposedFunction
 * https://pptr.dev/api/puppeteer.page.removeexposedfunction
 *
 * @param {object} page - Puppeteer Page instance
 * @param {string} name
 * @param {Function} fn
 */
async function exposeFunctionIfAbsent(page, name, fn) {
    const exist = await page.evaluate((name) => {
        return !!window[name];
    }, name);
    if (exist) {
        return;
    }
    try {
        await page.exposeFunction(name, fn);
    } catch (err) {
        // Puppeteer installs the binding in every frame of the page. If a
        // child frame (WhatsApp Web opens and closes some while loading) goes
        // away meanwhile, exposeFunction rejects with TargetCloseError even
        // though the main frame got the binding. Swallowing it only when the
        // binding is really there keeps the 'ready' event from being lost.
        if (!isTargetCloseError(err) || page.isClosed()) throw err;
        const installed = await page
            .waitForFunction(
                (name) => typeof window[name] === 'function',
                { timeout: 2000, polling: 100 },
                name,
            )
            .then(() => true)
            .catch(() => false);
        if (installed) return;
        await page.removeExposedFunction(name).catch(() => {});
        await page.exposeFunction(name, fn);
    }
}

function isTargetCloseError(err) {
    return (
        err?.name === 'TargetCloseError' ||
        /Target closed/.test(err?.message || '')
    );
}

module.exports = { exposeFunctionIfAbsent };
