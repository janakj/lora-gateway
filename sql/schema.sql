--
-- PostgreSQL database dump
--

-- Dumped from database version 13.4 (Debian 13.4-0+deb11u1)
-- Dumped by pg_dump version 13.4 (Debian 13.4-0+deb11u1)

-- Started on 2021-11-09 07:23:01 UTC

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- TOC entry 3003 (class 1262 OID 26153)
-- Name: lora; Type: DATABASE; Schema: -; Owner: postgres
--

CREATE DATABASE lora WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE = 'C.UTF-8';


ALTER DATABASE lora OWNER TO postgres;

\connect lora

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- TOC entry 201 (class 1259 OID 26162)
-- Name: attrs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.attrs (
    name text NOT NULL,
    value text
);


ALTER TABLE public.attrs OWNER TO postgres;

--
-- TOC entry 203 (class 1259 OID 26171)
-- Name: queue; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.queue (
    id integer NOT NULL,
    message_id text NOT NULL,
    message jsonb NOT NULL
);


ALTER TABLE public.queue OWNER TO postgres;

--
-- TOC entry 202 (class 1259 OID 26169)
-- Name: queue_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.queue_id_seq OWNER TO postgres;

--
-- TOC entry 3006 (class 0 OID 0)
-- Dependencies: 202
-- Name: queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.queue_id_seq OWNED BY public.queue.id;


--
-- TOC entry 200 (class 1259 OID 26155)
-- Name: seen; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.seen (
    id text NOT NULL
);


ALTER TABLE public.seen OWNER TO postgres;

--
-- TOC entry 2862 (class 2604 OID 26174)
-- Name: queue id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.queue ALTER COLUMN id SET DEFAULT nextval('public.queue_id_seq'::regclass);


--
-- TOC entry 2867 (class 2606 OID 26179)
-- Name: queue queue_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.queue
    ADD CONSTRAINT queue_pkey PRIMARY KEY (id);


--
-- TOC entry 2864 (class 1259 OID 26168)
-- Name: attrs_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX attrs_index ON public.attrs USING btree (name);


--
-- TOC entry 2865 (class 1259 OID 26180)
-- Name: queue_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX queue_index ON public.queue USING btree (message_id);


--
-- TOC entry 2863 (class 1259 OID 26161)
-- Name: seen_index; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX seen_index ON public.seen USING btree (id);


--
-- TOC entry 3004 (class 0 OID 0)
-- Dependencies: 201
-- Name: TABLE attrs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.attrs TO "lora-gateway";


--
-- TOC entry 3005 (class 0 OID 0)
-- Dependencies: 203
-- Name: TABLE queue; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.queue TO "lora-gateway";


--
-- TOC entry 3007 (class 0 OID 0)
-- Dependencies: 202
-- Name: SEQUENCE queue_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT USAGE ON SEQUENCE public.queue_id_seq TO "lora-gateway";


--
-- TOC entry 3008 (class 0 OID 0)
-- Dependencies: 200
-- Name: TABLE seen; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.seen TO "lora-gateway";


-- Completed on 2021-11-09 07:23:01 UTC

--
-- PostgreSQL database dump complete
--

