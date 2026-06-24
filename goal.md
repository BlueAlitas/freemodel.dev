## Proxy

I want you to build me a reverse proxy, a nodejs http server that would proxy an API, there are two tiers, T0 = https://cc.freemodel.dev and T2 = https://api- cc.freemodel.dev - When a request is made, if upstream responds with a status code that is not in the 200s, it should auto retry up to 10 times until 200 is retrieved while downstream never experiences the the error, store the latency, success/fail, status etc of these requests in the db, and add a reserverd  admin route for viewing active requests in the queue and their status and history of the requests (don't store body content), prioritize T2, and if T2 fails 10 times, then try 10 times again with T0, if upstream fails 20 times then you may send a failed response to downstream... note that this API is an anthropic compatible API so make sure to proxy headers and stream the content with keep alive and no timeout because it will be streaming LLM contents and they sometimes take a while. Figure out how the admin route will be accessed.

## Auth accounts

Add the ability to create accounts, each accounts are just an internally generated ID. No username/password, that generated ID can be used to log in, users must also be abel to delete their account.

A user will have an internally generated API key.

On the user's page, they will have the ability to add/remove their freemodel.dev API keys (and set their tier: T0 or T2) and set their prio.

Then when trying to make a request through the #Proxy, they can use the API key we internally generated for them and that will auto rotate through all of their API keys and auto retry 10 times for all of their API keys. the API key will be passed through the "Authorization" header, they may or may not pass through "Barear"
And if the provided key is not an internally generated KEY and not found in our DB, then that means it's a freemodel.dev api key so just proxy it normally.

## Admin
Admin should have the ability to delete accounts, view queued requests, with charts, disable or enable the system etc.
Keep track of how many requests were made, their status etc...