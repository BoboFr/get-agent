# Exemples de messages de commit

```
feat(cart): add quantity selector to cart items
```

```
fix(api): retry payment webhook on 503 responses

The provider returns 503 during maintenance windows and we were
dropping the event. Retries use the existing backoff helper.
```

```
refactor!: drop Node 18 support

BREAKING CHANGE: the package now requires Node.js 20.3 or later.
```
