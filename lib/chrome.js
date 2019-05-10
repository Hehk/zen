const ChromeLauncher = require('chrome-launcher')
const CDP = require('chrome-remote-interface')
const path = require('path')
const btoa = require('btoa')

module.exports = class ChromeWrapper {
  constructor(config) {
    this.config = config
  }

  // locally, we start a headless chrome instance to run tests
  launch(opts) {
    this.getBrowser = ChromeLauncher.launch({
      port: opts.port,
      chromePath: '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome',
      chromeFlags: ["--headless", "--disable-gpu"]
    }).then(chrome => {
      require('./util').writeFile(path.join(this.config.tmpDir, 'chrome.pid'), chrome.pid)
      return CDP({port: opts.port})
    })
  }

  // On lambda, chrome is already running and we just need to connect to it
  connectToRunning() {
    this.getBrowser = CDP({host: 'localhost', port: 9222})
  }

  async openTab(url, id) {
    let browser = await this.getBrowser
    let target = await browser.Target.createTarget({url: 'chrome://about'})
    let cdp = await CDP({target: target.targetId})
    await Promise.all([cdp.Console.enable(), cdp.Page.enable(), cdp.Runtime.enable(), cdp.Network.enable()])
    return new ChromeTab(cdp, id, url, this.config)
  }
}

// State is one of:
// loading: waiting for the page to load
// badCode: there was an error while loading. Nothing we can do until the code changes
// idle: Code is loaded, and we're waiting for a test
// hotReload: trying to update without a full page load
// running: a test is in progress
class ChromeTab {
  constructor(cdp, id, url, config) {
    this.id = id
    this.cdp = cdp
    this.config = config
    this.state = 'loading'
    this.codeHash = null // the version we'd like to be running
    this.test = null // the test we're supposed to run
    this.resolveWork = null // function to call when we have test results

    cdp.Console.messageAdded(this.onMessageAdded.bind(this))
    cdp.Runtime.exceptionThrown(this.onExceptionThrown.bind(this))

    if (cdp.Network.setRequestInterception)
      cdp.Network.setRequestInterception({patterns: [{interceptionStage: 'Request'}]})
    else
      cdp.Network.setRequestInterceptionEnabled({enabled: true}) // TODO upgrade chrome and remove this
    cdp.Network.requestIntercepted(this.onRequestIntercepted.bind(this))

    this.onTimeout = this.onTimeout.bind(this)
    this.timeout = setTimeout(this.onTimeout, 10 * 1000)
    cdp.Page.navigate({url})
    cdp.Target.activateTarget({targetId: this.cdp.target})
    // cdp.Page.setWebLifecycleState('active')
  }

  disconnect() {
    return CDP.Close({id: this.cdp.target}).then(() => {
      return this.cdp.close()
    })
  }

  changeState(state) {
    clearTimeout(this.timeout)
    this.state = state
  }

  setCodeHash(codeHash) {
    this.codeHash = codeHash
    if (this.state == 'idle') this.hotReload()
    else if (this.state == 'badCode') this.reload() // webpack hot reload can't recover from badCode
    // {loading,running,hotReload} will hot reload after they finish
  }

  setTest(opts) {
    if (this.test) this.resolveWork(null) // resolve the previous test

    let promise = new Promise(res => this.resolveWork = res)
    this.test = opts
    if (this.state == 'idle') this.run()
    else if (this.state == 'running') this.reload()
    else if (this.state == 'badCode')
      this.failTest(this.badCodeError, this.badCodeStack)
    // {loading,hotReload} will run the test after they finish
    return promise
  }

  // Attempt to hot reload the latest code
  hotReload() {
    if (this.config.skipHotReload) return this.reload()
    this.changeState('hotReload')
    this.timeout = setTimeout(this.onTimeout, 5000)
    this.cdp.Runtime.evaluate({expression: `Zen.upgrade(${JSON.stringify(this.codeHash)})`})
    this.codeHash = null
  }

  run() {
    this.changeState('running')
    this.startAt = new Date()
    this.timeout = setTimeout(this.onTimeout, 20 * 1000)
    this.cdp.Target.activateTarget({targetId: this.cdp.target}) // force the tab to have focus, otherwise focus events don't fire
    this.cdp.Runtime.evaluate({expression: `Zen.run(${JSON.stringify(this.test)})`})
  }

  badCode(msg, stack) {
    this.changeState('badCode')
    this.badCodeError = msg
    this.badCodeStack = stack.join('\n')
    if (this.test)
      this.failTest(msg, stack.join('\n'))
  }

  // We've finished our current task (hotReload or test) safely
  // If there's additional tasks, do them now.
  becomeIdle() {
    this.changeState('idle')
    if (this.codeHash) this.hotReload()
    else if (this.test) this.run()
  }

  reload() {
    this.changeState('loading')
    this.timeout = setTimeout(this.onTimeout, 10 * 1000)
    this.codeHash = null
    this.requestMap = {}
    console.log(`[${this.id}] reloading`)
    this.cdp.Page.reload() // TODO navigate to the correct url, in case the test has changed our location
  }

  onTimeout() {
    if (this.state == 'running') {
      this.failTest('Chrome-level test timeout')
    } else if (this.state == 'hotReload') {
      console.log(`[${this.id}] timeout while hotReloading`)
    } else if  (this.state === 'loading') {
      console.log(`[${this.id}] timeout while loading`)
    }

    // If we hit a timeout, the page is likely stuck and we don't really know
    // if it's safe to run tests. The best we can do is reload.
    this.reload()
  }

  onMessageAdded({message}) {
    console.log(`[${this.id}]`, message.text)
    if (message.text == 'Zen.idle' && this.state == 'loading') {
      this.becomeIdle()
    }

    if (message.text.startsWith('Zen.hotReload') && this.state == 'hotReload') {
      this.becomeIdle()
    }

    if (message.text.startsWith('Zen.results ') && this.state == 'running') {
      let msg = JSON.parse(message.text.slice(12))
      if (this.test && msg.runId == this.test.runId)
        this.finishTest(msg)
      this.becomeIdle()
    }
  }

  failTest(error, stack) {
    this.finishTest({runId: this.test.runId, error, stack, fullName: this.test.testName})
  }

  finishTest(msg) {
    msg.time = new Date() - this.startAt
    if (this.resolveWork)
      this.resolveWork(msg)
    this.resolveWork = null
    this.test = null
  }

  onExceptionThrown(opts) {
    let ex = opts.exceptionDetails, message

    if (ex.exception && ex.exception.className)
      message = `${ex.exception.className} ${ex.exception.description.split('\n')[0]}`
    else if (ex.exception.value)
      message = ex.exception.value
    else
      message = ex.text

    let stack = (ex.stackTrace && ex.stackTrace.callFrames) || []
    stack = stack.map(f => `${f.functionName} ${f.url}:${f.lineNumber}`)
    console.log(`[${this.id}]`, message, stack)

    // If an error happens while loading, your code is bad and we can't run anything
    if (this.state === 'loading') {
      this.badCode(message, stack)
    }

    // Some test suites (ie Superhuman) throw random errors that don't actually fail the test promise.
    // I'd like to track these all down and fix, but until then let us silently ignore, like karma.
    // Since we don't know which exceptions are safe to ignore, just reload.
    else if (this.state === 'running' && this.config.failOnExceptions) {
      this.failTest(message, stack.join('\n'))
      this.reload()
    }

    // Errors in either of these probably mean it's safer to reload
    else if (this.state === 'abort') this.reload()
    else if (this.state == 'hotReload') this.reload()
  }

  async onRequestIntercepted({interceptionId, request}) {
    let isToGateway = this.manifest && request.url.indexOf(this.manifest.proxyUrl) >= 0
    if (!this.manifest || !isToGateway) {
      return this.cdp.Network.continueInterceptedRequest({interceptionId})
    }

    let path = decodeURIComponent(request.url.replace(`${this.manifest.proxyUrl}/`, ''))
    if (path.match(/^index\.html/)) {
      console.log('sending index')
      let rawResponse = makeBase64Response('200 OK', this.manifest.index, 'text/html')
      return this.cdp.Network.continueInterceptedRequest({interceptionId, rawResponse})
    }

    let key = encodeURIComponent(this.manifest.files[path])
    if (key) {
      console.log(`${path} redirected to ${key}`)
      this.cdp.Network.continueInterceptedRequest({interceptionId, url: `${this.manifest.s3Url}/${key}`})
    } else {
      console.log(`${path} missing from manifest`)
      let rawResponse = makeBase64Response('404 Not Found')
      this.cdp.Network.continueInterceptedRequest({interceptionId, rawResponse})
    }
  }
}

function makeBase64Response(status, body = '', contentType = 'text/plain') {
  return btoa(
    `HTTP/1.1 ${status}\r\n` +
    `Date: ${(new Date()).toUTCString()}\r\n` +
    `Content-Type: ${contentType}\r\n` +
    `Content-Length: ${body.length}\r\n` +
    '\r\n\r\n' + body
  )
}
