# Contributing

Thanks for your interest in contributing! Here's how to get started.

## Requirements

- Node.js `20+`
- npm

## Getting Started

1. **Fork** the repository and clone your fork.
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes and commit with a clear message.
4. Push to your fork: `git push origin my-feature`
5. Open a **Pull Request** against `main`.

## Development

```bash
# Install all dependencies
npm install
cd poke-relay && npm install && cd ..

# Build and run the relay
npm run relay:build
npm run relay:start

# Start the frontend dev server (separate terminal)
npm run dev
```

## Code Style

- **Frontend**: React with hooks, vanilla CSS (no utility frameworks).
- **Relay**: TypeScript with strict mode, ESM modules.
- Keep functions small and well-named — no abbreviations in public APIs.

## Reporting Issues

When opening an issue, please include:

- Steps to reproduce the problem
- Expected vs. actual behavior
- Browser and Node.js version
- Relevant console output or screenshots

## Notes

- The browser stores the Poke API key and relay URL in `localStorage`.
- The relay reply store is in-memory, so restarting `poke-relay` clears queued replies.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
