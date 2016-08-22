require('dotenv').config({silent: true})
const ACCOUNT_SID = process.env.ACCOUNT_SID
const AUTH_TOKEN = process.env.AUTH_TOKEN
const PHONE = process.env.PHONE
const PORT = process.env.PORT || 3000
const DEV = process.env.NODE_ENV === 'development'
const APP_TITLE = process.env.APP_TITLE || require('./package.json').name
const COUCH_DB_URL = process.env.COUCH_DB_URL

const http = require('http')
const serverRouter = require('server-router')
const bankai = require('bankai')
const browserify = require('browserify')
const formBody = require('body/form')
const assert = require('assert')
const nano = require('nano')

const formatData = require('./format-data')

// Setup twilio client (or stub)
let twilio
if (DEV) {
  twilio = require('./fixtures/twilio/stub')
} else {
  assert(ACCOUNT_SID, 'ACCOUNT_SID environment variable is not defined')
  assert(AUTH_TOKEN, 'AUTH_TOKEN environment variable is not defined')
  assert(PHONE, 'PHONE environment variable is not defined')
  twilio = require('twilio')(ACCOUNT_SID, AUTH_TOKEN)
}

// Setup CouchDB
assert(COUCH_DB_URL, 'COUCH_DB_URL environment variable is not defined')
const db = nano(COUCH_DB_URL).use('messages')
seedWithMessages(db)
followPendingOutbound(db)

// Setup HTTP server
const router = setupStaticRouter()
setupInboundRoute(router, db)
http.createServer(router).listen(PORT, () => console.log('Listening on port', PORT))

// Fetch messages since last run (or a full page if empty db)
function seedWithMessages (db) {
  db.list({
    descending: true,
    limit: 1,
    include_docs: true,
    endkey: 'msg-' // _ comes before m in ASCII sort
  }, (err, body) => {
    if (err) return console.error(err)

    if (body.rows.length) {
      // If db already contains message records, fetch records since latest one
      console.log('most recent message', body.rows[0])
      twilio.messages.get({ 'DateSent>': body.rows[0].doc.date }, formatAndInsert)
    } else {
      // Otherwise it's a fresh db - fetch a page of messages
      console.log('no messages in db')
      twilio.messages.get({}, formatAndInsert)
    }
  })

  function formatAndInsert (err, messages) {
    if (err) return console.error('Error fetching messages from twilio')
    const formattedMessages = messages.messages.map(formatData.fromTwilioRest)
    db.bulk({ docs: formattedMessages }, (err, body) => {
      if (err) return console.error('Error inserting messages into database', err)
      console.log(body)
    })
  }
}

// Subscribe to pending outbound messages and send them to twilio
function followPendingOutbound (db) {
  const feed = db.follow({
    filter: 'messages/pending-outbound',
    include_docs: true
  })

  feed.on('change', (change) => {
    const payload = formatData.toTwilioRest(change.doc)
    payload.From = PHONE

    twilio.messages.post(payload, (err, response) => {
      if (err) return console.error('Error sending message to provider')

      const formattedResponse = formatData.fromTwilioRest(response)
      formattedResponse._id = change.id
      formattedResponse._rev = change.doc._rev
      console.log('outbound', formattedResponse)

      db.insert(formattedResponse, (err, body) => {
        if (err) return console.error('Error updating message in db', err)
      })
    })
  })
  feed.follow()
  return feed
}

// Serve client application
function setupStaticRouter () {
  const router = serverRouter()

  const html = bankai.html({ APP_TITLE })
  router.on('/', wrapHandler(html))

  const css = bankai.css()
  router.on('/bundle.css', wrapHandler(css))

  const js = bankai.js(browserify, __dirname + '/client/index.js', { transform: 'envify', debug: DEV })
  router.on('/bundle.js', wrapHandler(js))

  return router

  function wrapHandler (handler) {
    // bankai returns http route handlers that return a stream
    return (req, res) => handler(req, res).pipe(res)
  }
}

// Handle inbound messages from twilio webhooks
function setupInboundRoute (router, db) {
  router.on('/api/inbound', {
    post: function (req, res) {
      formBody(req, {}, (err, body) => {
        if (err) {
          res.statusCode = 400
          return
        }

        const formattedMessage = formatData.fromTwilioWebhook(body)
        console.log('inbound', formattedMessage)

        db.insert(formattedMessage, (err, body) => {
          if (err) {
            res.statusCode = 500
            console.error('Error inserting inbound message into db', err)
            return
          }
          res.end()
        })
      })
    }
  })
}
