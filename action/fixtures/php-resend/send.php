<?php

use Mastra\Agent;

function deliver($resend) {
    return $resend->emails->send([
        'from' => 'a@b.co',
        'to' => 'c@d.co',
        'subject' => 'Hi',
        'text' => 'Hi',
    ]);
}
