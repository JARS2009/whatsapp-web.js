const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');

const { exposeFunctionIfAbsent } = require('../../src/util/Puppeteer');

chai.use(chaiAsPromised);
const { expect } = chai;

function targetClosed() {
    const err = new Error(
        'Protocol error (Page.addScriptToEvaluateOnNewDocument): Target closed',
    );
    err.name = 'TargetCloseError';
    return err;
}

function fakePage({ exists = false, installed = true } = {}) {
    return {
        evaluate: sinon.stub().resolves(exists),
        exposeFunction: sinon.stub().resolves(),
        removeExposedFunction: sinon.stub().resolves(),
        isClosed: sinon.stub().returns(false),
        waitForFunction: installed
            ? sinon.stub().resolves()
            : sinon.stub().rejects(new Error('timeout')),
    };
}

describe('exposeFunctionIfAbsent', function () {
    it('does nothing when the function already exists', async function () {
        const page = fakePage({ exists: true });
        await exposeFunctionIfAbsent(page, 'fn', () => {});
        expect(page.exposeFunction.called).to.equal(false);
    });

    it('exposes the function when it is missing', async function () {
        const page = fakePage();
        const fn = () => {};
        await exposeFunctionIfAbsent(page, 'fn', fn);
        expect(page.exposeFunction.calledOnceWith('fn', fn)).to.equal(true);
    });

    it('ignores a closed child frame when the main frame got the binding', async function () {
        const page = fakePage({ installed: true });
        page.exposeFunction.rejects(targetClosed());
        await exposeFunctionIfAbsent(page, 'fn', () => {});
        expect(page.exposeFunction.calledOnce).to.equal(true);
        expect(page.removeExposedFunction.called).to.equal(false);
    });

    it('re-exposes when the binding did not reach the main frame', async function () {
        const page = fakePage({ installed: false });
        page.exposeFunction.onFirstCall().rejects(targetClosed());
        page.exposeFunction.onSecondCall().resolves();
        await exposeFunctionIfAbsent(page, 'fn', () => {});
        expect(page.removeExposedFunction.calledOnceWith('fn')).to.equal(true);
        expect(page.exposeFunction.calledTwice).to.equal(true);
    });

    it('rethrows other errors', async function () {
        const page = fakePage();
        page.exposeFunction.rejects(new Error('boom'));
        await expect(
            exposeFunctionIfAbsent(page, 'fn', () => {}),
        ).to.be.rejectedWith('boom');
    });

    it('rethrows when the whole page is closed', async function () {
        const page = fakePage();
        page.isClosed.returns(true);
        page.exposeFunction.rejects(targetClosed());
        await expect(
            exposeFunctionIfAbsent(page, 'fn', () => {}),
        ).to.be.rejectedWith('Target closed');
    });
});
