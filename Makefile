# Makefile for homebridge-christie-projector TypeScript build

SHELL := /bin/zsh

# Load user environment & discover node/npm across Homebrew, NVM, Volta, fnm, MacPorts, and system paths
ENV_SETUP := \
	setopt +o nomatch 2>/dev/null || true; \
	export PATH="/opt/homebrew/bin:/usr/local/bin:$$HOME/.volta/bin:$$HOME/.fnm/current/bin:$$HOME/.local/share/fnm/aliases/default/bin:$$HOME/.asdf/shims:/opt/local/bin:$$PATH"; \
	for d in $$HOME/.nvm/versions/node/*/bin(N) /opt/homebrew/opt/node*/bin(N) /usr/local/opt/node*/bin(N); do \
		[ -d "$$d" ] && export PATH="$$d:$$PATH"; \
	done; \
	[ -s "$$HOME/.zprofile" ] && source "$$HOME/.zprofile" >/dev/null 2>&1 || true; \
	[ -s "$$HOME/.zshrc" ] && source "$$HOME/.zshrc" >/dev/null 2>&1 || true

TSC := ./node_modules/.bin/tsc
SRC_DIR := src
DIST_DIR := dist

.PHONY: all build compile check typecheck watch test clean distclean rebuild install hooks bump release help

## Default target: configure git hooks and compile TypeScript sources
all: hooks build

## Install local Git hooks so version automatically increments when changes are committed/pushed
hooks:
	@if [ -d ".git" ] && [ -f ".githooks/pre-commit" ]; then \
		chmod +x .githooks/pre-commit; \
		cp .githooks/pre-commit .git/hooks/pre-commit; \
		chmod +x .git/hooks/pre-commit; \
		git config core.hooksPath .githooks 2>/dev/null || true; \
	fi

## Install npm dependencies if node_modules/.bin/tsc is missing
$(TSC):
	@$(ENV_SETUP); \
	if [ ! -f "$(TSC)" ]; then \
		npm install; \
	fi

## Install dependencies explicitly
install: hooks
	@$(ENV_SETUP); npm install

## Compile TypeScript to JavaScript & type declarations in dist/
build: hooks $(TSC)
	@echo "Building TypeScript sources..."
	@$(ENV_SETUP); node $(TSC) -p tsconfig.json --pretty false
	@echo "TypeScript build complete -> $(DIST_DIR)/"

compile: build

## Increment patch version in package.json & package-lock.json
bump:
	@$(ENV_SETUP); \
	NEW_VER=$$(npm version patch --no-git-tag-version); \
	echo "Bumped plugin version to $$NEW_VER"

## Bump version, rebuild dist/, and run tests
release: bump build test

## Type-check TypeScript sources without emitting files
check: $(TSC)
	@$(ENV_SETUP); node $(TSC) -p tsconfig.json --noEmit --pretty false

typecheck: check

## Watch TypeScript sources and recompile on changes
watch: $(TSC)
	@$(ENV_SETUP); node $(TSC) -p tsconfig.json --watch

## Build and run the test suite
test: build
	@$(ENV_SETUP); node test-christie.mjs

## Remove compiled output (dist/ and tsbuildinfo)
clean:
	@echo "Cleaning $(DIST_DIR)/..."
	rm -rf $(DIST_DIR) *.tsbuildinfo

## Remove compiled output and node_modules
distclean: clean
	rm -rf node_modules

## Clean and rebuild from scratch
rebuild: clean build

## Show available Makefile targets
help:
	@echo "Available targets:"
	@echo "  make          (or make build)     Compile TypeScript in src/ to dist/ and install git hooks"
	@echo "  make hooks                        Install git hooks for automatic version bumping"
	@echo "  make bump                         Increment patch version in package.json"
	@echo "  make release                      Bump patch version, build dist/, and run tests"
	@echo "  make check    (or make typecheck) Run TypeScript type-checking (--noEmit)"
	@echo "  make watch                        Compile in watch mode"
	@echo "  make test                         Build and run unit tests (test-christie.mjs)"
	@echo "  make clean                        Remove dist/ build artifacts"
	@echo "  make rebuild                      Clean and rebuild TypeScript"
	@echo "  make install                      Install npm dependencies"
	@echo "  make distclean                    Remove dist/ and node_modules/"
