db_ssh ?= dbj
db_name ?= lora

all: schema data

schema.sql: .FORCE
	ssh $(db_ssh) pg_dump -Csv $(db_name) > $@

data.sql: .FORCE
	ssh $(db_ssh) pg_dump -av $(db_name) > $@

.PHONY: .FORCE
.FORCE:

schema:: schema.sql
data:: data.sql

