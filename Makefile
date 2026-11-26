.PHONY: sandbox stop logs test trap-pack
sandbox:
	docker compose up --build -d --wait

stop:
	docker compose down

logs:
	docker compose logs -f

test:
	pnpm test

trap-pack:
	pnpm test:adversarial
