.PHONY: sandbox stop logs test
sandbox:
	docker compose up --build -d --wait

stop:
	docker compose down

logs:
	docker compose logs -f

test:
	pnpm test
