CREATE DATABASE IF NOT EXISTS chat_app;

USE chat_app;

CREATE TABLE IF NOT EXISTS users(
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS user_rooms(
    user_id INT NOT NULL,
    room_name VARCHAR(255) NOT NULL,
    PRIMARY KEY (user_id, room_name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);


DROP TABLE IF EXISTS messages;

SHOW TABLES;

DESCRIBE user_rooms;
