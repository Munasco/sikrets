# Configuring the client

Set the key in your shell, never in code:

```sh
export OPENAI_API_KEY="$(sikrets get openai)"
alchemy profile edit --set token=$HCLOUD_TOKEN
```

```ts
const apiKey = process.env.OPENAI_API_KEY;
const client = new Client({ apiKey, authToken: await getToken() });
```

| Variable | Example |
| --- | --- |
| `API_KEY` | `your-api-key-goes-here` |
| `DB_PASSWORD` | `<your database password>` |
